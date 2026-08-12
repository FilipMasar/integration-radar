import { Actor, log } from 'apify';
import type { KeyValueStore } from 'apify';
import type { PageHit } from './pure.js';

/**
 * A *named* store, so it survives between runs — unnamed stores are deleted once the
 * run falls out of the 10 most recent. It holds the page cache (Markdown plus the names
 * extracted from it) and the previous run's candidate list.
 */
let store: KeyValueStore | null = null;
let storePromise: Promise<KeyValueStore> | null = null;

/**
 * Bounded concurrency (mapLimit) means multiple callers can race here before `store`
 * is first assigned. Sharing one in-flight promise means every racer awaits the same
 * open call instead of each issuing its own `Actor.openKeyValueStore` — almost
 * certainly harmless either way (the platform resolves same-named stores to the same
 * underlying store), but this avoids the redundant calls outright.
 *
 * A failed open must not poison every later call for the life of the process: the
 * `.catch` clears `storePromise` before rethrowing, so the next `getStore()` call
 * retries with a fresh `Actor.openKeyValueStore` instead of re-awaiting (and
 * re-throwing) the same stale rejection forever — the property the old plain-`let`
 * version had implicitly, since `store` stayed `null` on error.
 */
export async function getStore(): Promise<KeyValueStore> {
    if (store) return store;
    if (!storePromise) {
        storePromise = Actor.openKeyValueStore('integration-radar').catch((err: unknown) => {
            storePromise = null;
            throw err;
        });
    }
    store = await storePromise;
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

/**
 * Parses an env-configured TTL, read fresh at call time rather than cached once at
 * module load — a test (or a mid-run env change) can set `process.env` and see it
 * take effect immediately, no reimport required. Falls back loudly-safe to `fallback`
 * on anything `Number()` can't parse: `ageHours > NaN` is always `false`, so a
 * mistyped `CACHE_TTL_HOURS=abc` would otherwise make the cache silently immortal
 * instead of failing in an obvious way. `0` is a valid TTL (forced expiry) and must
 * pass through unchanged.
 */
export function ttlHours(raw: string | undefined, fallback: number): number {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
}

const DEFAULT_CACHE_TTL_HOURS = 24;
const DEFAULT_MISS_TTL_HOURS = 6;

/** Pure age check, factored out so the comparison itself is unit-testable without a store. */
export function isExpired(fetchedAt: string, maxAgeHours: number): boolean {
    const ageHours = (Date.now() - new Date(fetchedAt).getTime()) / 3_600_000;
    return ageHours > maxAgeHours;
}

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

    if (isExpired(record.fetchedAt, ttlHours(process.env.CACHE_TTL_HOURS, DEFAULT_CACHE_TTL_HOURS))) {
        const ageHours = (Date.now() - new Date(record.fetchedAt).getTime()) / 3_600_000;
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

    if (isExpired(record.fetchedAt, ttlHours(process.env.CACHE_TTL_HOURS, DEFAULT_CACHE_TTL_HOURS))) {
        const ageHours = (Date.now() - new Date(record.fetchedAt).getTime()) / 3_600_000;
        log.info('Names expired', { key, ageHours: Math.round(ageHours) });
        return null;
    }
    return record.names;
}

export async function writeNames(key: string, names: string[]): Promise<void> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    // Only ever attach to an existing page record. A names entry with no page behind it
    // would outlive its source and quietly go stale.
    if (record) await kv.setValue(key, { ...record, names });
}

/** The only two reasons either call site actually produces today — see writeMiss's callers. */
type MissReason = 'thin' | 'no-match';

interface MissRecord {
    missedAt: string;
    /**
     * Optional, purely for observability today — the caller never branches on it, a
     * miss is a miss regardless of reason. Pinned to the closed union rather than an
     * open `string` so a third call site adding a new reason has to update this type
     * (and everywhere that matches on it) rather than silently type-checking a typo.
     * A future fetch layer that can see the actual HTTP status (a 404 vs. a 200 with
     * no body are different facts, both currently invisible to us behind
     * rag-web-browser) can extend this union with a new member when that need is real.
     */
    reason?: MissReason;
}

function missKey(key: string): string {
    return `${key}-miss`;
}

/**
 * A known-miss marker for a resolution that came up empty (no page at that URL, or
 * no path/search result that looked right) — and *only* that. A thrown attempt is not
 * evidence of absence and must never reach here; see the call sites in `web.ts` for
 * the completed-vs-threw distinction that guards this. Stored under a *separate* key
 * from the page record, never as a falsy value inside it — an earlier draft cached
 * `[]` for a failed search, and `[]` is truthy in JS, so it read back as a cache *hit*
 * and permanently disabled the search tier for that domain. A dedicated marker key
 * with its own short TTL can only ever mean "known miss, still fresh," and expires on
 * its own schedule so a page published after the miss is picked up again on some
 * later run rather than staying dark forever.
 */
export async function readMiss(key: string): Promise<boolean> {
    const kv = await getStore();
    const record = await kv.getValue<MissRecord>(missKey(key));
    if (!record) return false;

    if (isExpired(record.missedAt, ttlHours(process.env.MISS_TTL_HOURS, DEFAULT_MISS_TTL_HOURS))) {
        return false;
    }
    log.info('Known miss', { key, reason: record.reason });
    return true;
}

export async function writeMiss(key: string, reason?: MissReason): Promise<void> {
    const kv = await getStore();
    await kv.setValue(missKey(key), { missedAt: new Date().toISOString(), reason } satisfies MissRecord);
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
