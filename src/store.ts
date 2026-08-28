import type { KeyValueStore } from 'apify';
import { Actor, log } from 'apify';

import type { Company, Memory } from './pure.js';
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

function ageHours(fetchedAt: string): number {
    return (Date.now() - new Date(fetchedAt).getTime()) / 3_600_000;
}

export function isExpired(fetchedAt: string, maxAgeHours: number): boolean {
    return ageHours(fetchedAt) > maxAgeHours;
}

interface CacheRecord {
    fetchedAt: string;
    names: string[];
}

async function readFresh(key: string): Promise<CacheRecord | null> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    if (!record) return null;

    if (isExpired(record.fetchedAt, ttlHours(process.env.CACHE_TTL_HOURS, DEFAULT_CACHE_TTL_HOURS))) return null;
    return record;
}

function integrationsKey(domain: string): string {
    return cacheKey('integrations', sourceName(domain));
}

export async function readIntegrations(domain: string): Promise<string[] | null> {
    return (await readFresh(integrationsKey(domain)))?.names ?? null;
}

export async function writeIntegrations(domain: string, names: string[]): Promise<void> {
    const kv = await getStore();
    await kv.setValue(integrationsKey(domain), {
        fetchedAt: new Date().toISOString(),
        names,
    } satisfies CacheRecord);
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
