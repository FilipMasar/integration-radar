import type { KeyValueStore } from 'apify';
import { Actor, log } from 'apify';

import type { Company, Memory, PageHit } from './pure.js';
import { sourceName } from './pure.js';

// Named on purpose: unnamed stores are deleted once the run drops out of the 10 most recent.
let store: KeyValueStore | null = null;

export async function getStore(): Promise<KeyValueStore> {
    if (!store) store = await Actor.openKeyValueStore('integration-radar');
    return store;
}

export function cacheKey(prefix: string, value: string): string {
    const flat = value
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '')
        .replace(/[^a-zA-Z0-9]+/g, '-');
    // Store keys allow only [a-zA-Z0-9!-_.'()] and 256 chars; 190 leaves room for the prefix.
    return `${prefix}-${flat.slice(0, 190)}`;
}

export function ttlHours(raw: string | undefined, fallback: number): number {
    // Fall back on anything unparseable: `age > NaN` is false, so a typo'd TTL would never expire.
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
}

const DEFAULT_CACHE_TTL_HOURS = 24;
const DEFAULT_MISS_TTL_HOURS = 6;

function ageHours(fetchedAt: string): number {
    return (Date.now() - new Date(fetchedAt).getTime()) / 3_600_000;
}

export function isExpired(fetchedAt: string, maxAgeHours: number): boolean {
    return ageHours(fetchedAt) > maxAgeHours;
}

interface CacheRecord {
    fetchedAt: string;
    hit: PageHit;
    names?: string[];
    isListPage?: boolean;
}

async function readFresh(key: string): Promise<CacheRecord | null> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    if (!record) return null;

    if (isExpired(record.fetchedAt, ttlHours(process.env.CACHE_TTL_HOURS, DEFAULT_CACHE_TTL_HOURS))) return null;
    return record;
}

async function patchRecord(key: string, fields: Partial<CacheRecord>): Promise<void> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    if (record) await kv.setValue(key, { ...record, ...fields });
}

export async function readCache(key: string): Promise<PageHit | null> {
    return (await readFresh(key))?.hit ?? null;
}

export async function writeCache(key: string, hit: PageHit): Promise<void> {
    const kv = await getStore();
    await kv.setValue(key, { fetchedAt: new Date().toISOString(), hit } satisfies CacheRecord);
}

export async function readNames(key: string): Promise<string[] | null> {
    return (await readFresh(key))?.names ?? null;
}

export async function writeNames(key: string, names: string[]): Promise<void> {
    await patchRecord(key, { names });
}

// `null`, not `false` — `false` is a real cached verdict, so the `?? null` must stay as it is.
export async function readListPageVerdict(key: string): Promise<boolean | null> {
    return (await readFresh(key))?.isListPage ?? null;
}

export async function writeListPageVerdict(key: string, isListPage: boolean): Promise<void> {
    await patchRecord(key, { isListPage });
}

interface MissRecord {
    missedAt: string;
}

function missKey(key: string): string {
    return `${key}-miss`;
}

export async function readMiss(key: string): Promise<boolean> {
    const kv = await getStore();
    const record = await kv.getValue<MissRecord>(missKey(key));
    if (!record) return false;

    return !isExpired(record.missedAt, ttlHours(process.env.MISS_TTL_HOURS, DEFAULT_MISS_TTL_HOURS));
}

export async function writeMiss(key: string): Promise<void> {
    const kv = await getStore();
    await kv.setValue(missKey(key), { missedAt: new Date().toISOString() } satisfies MissRecord);
}

interface SeedRecord {
    seededAt: string;
    competitors: Company[];
}

function seedKey(domain: string, maxCompetitors: number): string {
    return cacheKey('seed', `${sourceName(domain)}-${maxCompetitors}`);
}

// Read with no expiry check, unlike every other record: a seed that re-rolls fabricates NEW rows.
export async function readSeed(domain: string, maxCompetitors: number): Promise<Company[] | null> {
    const kv = await getStore();
    const record = await kv.getValue<SeedRecord>(seedKey(domain, maxCompetitors));
    if (!record?.competitors?.length) return null;
    return record.competitors;
}

export async function writeSeed(domain: string, maxCompetitors: number, competitors: Company[]): Promise<void> {
    if (competitors.length === 0) return;
    const kv = await getStore();
    await kv.setValue(seedKey(domain, maxCompetitors), {
        seededAt: new Date().toISOString(),
        competitors,
    } satisfies SeedRecord);
}

export interface StoredMemory extends Memory {
    fingerprint: string | null;
}

interface PreviousRun extends Partial<StoredMemory> {
    date?: string;
    slugs: string[];
}

// Keyed on the raw domain, unlike everything else — safe only while the schema forbids uppercase.
// If that changes, normalize here and in `savePrevious` together, or history silently rebaselines.
export async function loadPrevious(companyDomain: string): Promise<StoredMemory | null> {
    const kv = await getStore();
    const record = await kv.getValue<PreviousRun>(cacheKey('previous', companyDomain));
    if (!record) return null;
    log.debug('Loaded previous run', {
        date: record.date,
        count: record.slugs.length,
        sources: record.sources?.length ?? 0,
        fingerprinted: record.fingerprint !== undefined,
    });
    return {
        slugs: record.slugs,
        sources: record.sources ?? [],
        fingerprint: record.fingerprint ?? null,
    };
}

export async function savePrevious(companyDomain: string, memory: StoredMemory, runDate: string): Promise<void> {
    const kv = await getStore();
    await kv.setValue(cacheKey('previous', companyDomain), { date: runDate, ...memory });
}
