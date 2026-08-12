import type { KeyValueStore } from 'apify';
import { Actor, log } from 'apify';

import type { Company, Memory, PageHit } from './pure.js';

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
    /**
     * The search-tier `isListPage` gate's verdict on this page, cached the same way as
     * `names` below — see `readListPageVerdict`/`writeListPageVerdict`.
     */
    isListPage?: boolean;
    /**
     * The competitor set extracted from an alternatives page — the same co-location
     * rule as `names`, for a page whose extraction has a different shape. See
     * `readCompetitors`/`writeCompetitors`.
     */
    competitors?: Company[];
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

/**
 * The search-tier list-page gate's verdict, cached against the same record as the page
 * it judged — same shape and rationale as `readNames`/`writeNames` above.
 *
 * Added in fix round 1, after review: `main.ts` used to call `isListPage` on every
 * search-tier hit unconditionally, including a page served straight from this cache.
 * Re-running an LLM verdict on byte-identical content every run is not just wasted
 * cost — at `temperature: 0` the verdict is *expected* to be stable but is not
 * guaranteed to be (queued/routed inference is a known source of residual variance,
 * and this codebase has already measured comparable flakiness one layer down, in
 * `findList`'s search resolution itself). An accepted→rejected flip on unchanged
 * content is silently absorbed by the carry-forward rule in `main.ts` (it just reads
 * as "this source didn't resolve"), but a rejected→accepted flip has no safety net at
 * all: it injects a spurious `NEW` sourced from nothing but model nondeterminism.
 * Deciding once per cached page, not once per run, removes both the cost and this
 * correctness risk.
 *
 * Returns `null` (not `false`) when no verdict has been cached yet, so a caller can
 * tell "never gated" apart from "gated and rejected" — `false` is a real, meaningful
 * cached answer, not an absence of one.
 */
export async function readListPageVerdict(key: string): Promise<boolean | null> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    if (!record || record.isListPage === undefined) return null;

    if (isExpired(record.fetchedAt, ttlHours(process.env.CACHE_TTL_HOURS, DEFAULT_CACHE_TTL_HOURS))) {
        return null;
    }
    return record.isListPage;
}

export async function writeListPageVerdict(key: string, isListPage: boolean): Promise<void> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    // Only ever attach to an existing page record — same rule as writeNames, and for
    // the same reason: a verdict with no page behind it would outlive its source.
    if (record) await kv.setValue(key, { ...record, isListPage });
}

/**
 * The competitor set extracted from an alternatives page, cached against that page's
 * record exactly like `names` — same key, same TTL, same "cannot outlive the page it
 * came from" guarantee.
 *
 * This was the one extraction with no cache, so an LLM re-derived the competitor set
 * from a marketing page on *every* run, warm or cold. That matters far beyond cost:
 * the competitor list is the source set the whole run is built on, and a set that is
 * re-rolled every run is a set that can silently shrink, taking the candidates that
 * only that competitor carried out of the run's evidence with it. Deciding once per
 * cached page removes the re-roll within the TTL window and cuts an LLM call from
 * every warm run.
 *
 * Returns `null` for "no competitors cached", never `[]` — an empty extraction is not
 * worth caching (the caller treats it as fatal) and `[]` would read back as a hit.
 */
export async function readCompetitors(key: string): Promise<Company[] | null> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    if (!record?.competitors?.length) return null;

    if (isExpired(record.fetchedAt, ttlHours(process.env.CACHE_TTL_HOURS, DEFAULT_CACHE_TTL_HOURS))) {
        log.info('Competitors expired', { key });
        return null;
    }
    return record.competitors;
}

export async function writeCompetitors(key: string, competitors: Company[]): Promise<void> {
    const kv = await getStore();
    const record = await kv.getValue<CacheRecord>(key);
    // Only ever attach to an existing page record — same rule as writeNames.
    if (record) await kv.setValue(key, { ...record, competitors });
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

/**
 * `Memory` plus the conditions it was gathered under. The fingerprint is what lets the
 * next run notice that it is about to diff against a picture taken through a different
 * lens (a different `maxCompetitors`, a different `directories` list) and declare a
 * baseline instead of inventing `NEW` rows — see `inputFingerprint` in `pure.ts`.
 */
export interface StoredMemory extends Memory {
    /** `null` for a record written before fingerprinting existed. */
    fingerprint: string | null;
}

interface PreviousRun extends Partial<StoredMemory> {
    date?: string;
    slugs: string[];
}

/**
 * Returns `null` when there is no memory at all — distinct from a record whose `slugs`
 * happen to be empty, and distinct from a pre-fingerprint record. The caller needs all
 * three apart: no record is a genuine first run, while a record with no fingerprint was
 * written under unknown conditions and must be treated as a baseline rather than
 * silently diffed against.
 *
 * **Trap for whoever relaxes `companyDomain`'s lowercase-only input pattern.** This key
 * and `savePrevious`'s are built from the *raw* `companyDomain` string, unlike everything
 * else downstream, which runs it through `sourceName` (the fingerprint, both dedup
 * comparisons). That is safe only because the input schema rejects uppercase today. The
 * moment `Apify.com` becomes valid input it gets its own memory record, silently
 * rebaselines against `apify.com`'s history, and reports a full page of `NEW` — the exact
 * defect this whole mechanism exists to prevent. Normalize with `sourceName` at *both*
 * ends of this pair in the same change that relaxes the pattern, and note that existing
 * records keyed on a raw string do not migrate themselves.
 */
export async function loadPrevious(companyDomain: string): Promise<StoredMemory | null> {
    const kv = await getStore();
    const record = await kv.getValue<PreviousRun>(cacheKey('previous', companyDomain));
    if (!record) {
        log.info('No previous run — this is a baseline');
        return null;
    }
    log.info('Loaded previous run', {
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

export async function savePrevious(
    companyDomain: string,
    memory: StoredMemory,
    runDate: string,
): Promise<void> {
    const kv = await getStore();
    await kv.setValue(cacheKey('previous', companyDomain), { date: runDate, ...memory });
}
