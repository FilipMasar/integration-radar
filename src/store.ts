import { Actor, log } from 'apify';
import type { KeyValueStore } from 'apify';
import type { PageHit } from './pure.js';

/**
 * A *named* store, so it survives between runs — unnamed stores are deleted once the
 * run falls out of the 10 most recent. It holds the page cache (Markdown plus the names
 * extracted from it) and the previous run's candidate list.
 */
let store: KeyValueStore | null = null;

export async function getStore(): Promise<KeyValueStore> {
    if (!store) store = await Actor.openKeyValueStore('integration-radar');
    return store;
}

/** Keys allow only [a-zA-Z0-9!-_.'()] and max 256 chars; 200 is a safe ceiling. */
export function cacheKey(prefix: string, value: string): string {
    const flat = value
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '') // trailing slash must not create a second key
        .replace(/[^a-zA-Z0-9]+/g, '-');
    return `${prefix}-${flat.slice(0, 190)}`;
}

const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS ?? 24);

interface CacheRecord {
    fetchedAt: string;
    hit: PageHit;
    /** Filled in after extraction, so a restarted run does not pay for the LLM twice. */
    names?: string[];
}

/** Returns null on a miss OR on an expired entry — expiry is what makes change detection possible. */
export async function readCache(key: string): Promise<PageHit | null> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    if (!record) return null;

    const ageHours = (Date.now() - new Date(record.fetchedAt).getTime()) / 3_600_000;
    if (ageHours > CACHE_TTL_HOURS) {
        log.info('Cache expired', { key, ageHours: Math.round(ageHours) });
        return null;
    }
    return record.hit;
}

export async function writeCache(key: string, hit: PageHit): Promise<void> {
    const kv = await getStore();
    await kv.setValue(key, { fetchedAt: new Date().toISOString(), hit } satisfies CacheRecord);
}

/**
 * The extracted name list, stored in the same record as the page it came from, so the
 * two can never disagree about freshness. LLM calls are roughly half the cost of a run
 * and are not otherwise recoverable — if the container is migrated mid-run, `main.ts`
 * restarts from the top and would re-extract every page it had already read.
 */
export async function readNames(key: string): Promise<string[] | null> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    if (!record?.names) return null;

    const ageHours = (Date.now() - new Date(record.fetchedAt).getTime()) / 3_600_000;
    return ageHours > CACHE_TTL_HOURS ? null : record.names;
}

export async function writeNames(key: string, names: string[]): Promise<void> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    // Only ever attach to an existing page record. A names entry with no page behind it
    // would outlive its source and quietly go stale.
    if (record) await kv.setValue(key, { ...record, names });
}

interface PreviousRun {
    date: string;
    slugs: string[];
}

export async function loadPrevious(companyDomain: string): Promise<string[]> {
    const kv = await getStore();
    const record = await kv.getValue<PreviousRun>(cacheKey('previous', companyDomain));
    if (record) log.info('Loaded previous run', { date: record.date, count: record.slugs.length });
    else log.info('No previous run — this is a baseline');
    return record?.slugs ?? [];
}

export async function savePrevious(
    companyDomain: string,
    slugs: string[],
    runDate: string,
): Promise<void> {
    const kv = await getStore();
    await kv.setValue(cacheKey('previous', companyDomain), { date: runDate, slugs });
}
