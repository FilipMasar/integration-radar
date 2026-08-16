import type { KeyValueStore } from 'apify';
import { Actor, log } from 'apify';

import type { Company, Memory, PageHit } from './pure.js';
import { sourceName } from './pure.js';

/**
 * A *named* store, so it survives between runs — unnamed stores are deleted once the run
 * falls out of the 10 most recent. Holds the page cache (Markdown plus extracted names),
 * the competitor seed, and the previous run's candidate list.
 *
 * A failed open leaves `store` null, so the next caller retries rather than inheriting
 * the failure.
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
        .replace(/\/+$/, '') // a trailing slash must not create a second key
        .replace(/[^a-zA-Z0-9]+/g, '-');
    return `${prefix}-${flat.slice(0, 190)}`;
}

/**
 * Parse an env-configured TTL, read at call time so a test or a mid-run change takes
 * effect immediately. Falls back on anything `Number()` cannot parse: `ageHours > NaN` is
 * always false, so a mistyped `CACHE_TTL_HOURS=abc` would otherwise make the cache
 * silently immortal. `0` is a valid TTL (forced expiry) and passes through.
 */
export function ttlHours(raw: string | undefined, fallback: number): number {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
}

const DEFAULT_CACHE_TTL_HOURS = 24;
const DEFAULT_MISS_TTL_HOURS = 6;

/** Factored out so the age comparison is unit-testable without a store. */
export function isExpired(fetchedAt: string, maxAgeHours: number): boolean {
    const ageHours = (Date.now() - new Date(fetchedAt).getTime()) / 3_600_000;
    return ageHours > maxAgeHours;
}

interface CacheRecord {
    fetchedAt: string;
    hit: PageHit;
    /** Filled in after extraction, so a restarted run does not pay for the LLM twice. */
    names?: string[];
    /** The search-tier gate's verdict on this page — see `readListPageVerdict`. */
    isListPage?: boolean;
}

/** Null on a miss OR on an expired entry — expiry is what makes change detection possible. */
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
 * The extracted name list, stored in the same record as the page it came from so the two
 * can never disagree about freshness. LLM calls are roughly half the cost of a run and are
 * not otherwise recoverable: a container migration restarts `main.ts` from the top.
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
    // Only ever attach to an existing page record: a names entry with no page behind it
    // would outlive its source and quietly go stale.
    if (record) await kv.setValue(key, { ...record, names });
}

/**
 * The search-tier gate's verdict, cached against the page it judged — same shape and
 * reasoning as `readNames`.
 *
 * Deciding once per cached page rather than once per run is a correctness measure, not
 * only a cost one. At `temperature: 0` the verdict is expected to be stable but is not
 * guaranteed to be. An accepted -> rejected flip on unchanged content is absorbed by the
 * carry-forward rule (it reads as "this source didn't resolve"), but rejected -> accepted
 * has no safety net: it injects a spurious `NEW` sourced from nothing but nondeterminism.
 *
 * Returns `null`, not `false`, when nothing is cached — `false` is a real cached answer,
 * not an absence of one.
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
    // Same rule as `writeNames`: never outlive the page record.
    if (record) await kv.setValue(key, { ...record, isListPage });
}

interface MissRecord {
    missedAt: string;
}

function missKey(key: string): string {
    return `${key}-miss`;
}

/**
 * A marker for a resolution that came up empty — and *only* that. A thrown attempt is not
 * evidence of absence and must never reach here; see the call sites in `web.ts`.
 *
 * Stored under a separate key, never as a falsy value inside the page record: an earlier
 * draft cached `[]` for a failed search, and `[]` is truthy, so it read back as a cache
 * *hit* and permanently disabled the search tier for that domain. A dedicated key with its
 * own short TTL can only mean "known miss, still fresh", and expires on its own schedule
 * so a page published after the miss is picked up later rather than staying dark forever.
 */
export async function readMiss(key: string): Promise<boolean> {
    const kv = await getStore();
    const record = await kv.getValue<MissRecord>(missKey(key));
    if (!record) return false;

    if (isExpired(record.missedAt, ttlHours(process.env.MISS_TTL_HOURS, DEFAULT_MISS_TTL_HOURS))) {
        return false;
    }
    log.info('Known miss', { key });
    return true;
}

export async function writeMiss(key: string): Promise<void> {
    const kv = await getStore();
    await kv.setValue(missKey(key), { missedAt: new Date().toISOString() } satisfies MissRecord);
}

interface SeedRecord {
    /** Observability only, never compared against a TTL. It earns its place precisely
     *  because the record never expires: without it nobody inspecting the store can tell
     *  whether a seed was derived today or a year ago. */
    seededAt: string;
    competitors: Company[];
}

/**
 * Keyed on the inputs that actually determine the seed, not on the full input
 * fingerprint. Keep the two apart as inputs are added: the fingerprint's job is to declare
 * a baseline whenever the run's *lens* changes, which is a much broader trigger than "the
 * set of competitors that exist has changed". Keying the seed on the fingerprint would let
 * an input with no bearing on the market re-roll the competitor set, and a seed that
 * re-rolls between runs is the fabricated-NEW problem `readSeed` exists to prevent.
 *
 * The domain goes through `sourceName`, unlike `loadPrevious`'s raw-string key, so
 * `Apify.com` and `apify.com` cannot fork.
 */
function seedKey(domain: string, maxCompetitors: number): string {
    return cacheKey('seed', `${sourceName(domain)}-${maxCompetitors}`);
}

/**
 * The competitor seed. **Read with no expiry check, on purpose — the only record here that
 * works that way.**
 *
 * The seed is the source set the entire diff rests on. One that re-rolls between runs
 * makes candidates silently enter and leave the evidence base, which is the fabricated-NEW
 * problem this cache exists to prevent. So it is derived once and kept: new competitors
 * enter only when the key changes (`maxCompetitors`, the domain), when a user passes
 * `competitors` explicitly, or when this record is deleted.
 *
 * Returns `null` for "nothing stored", never `[]` — an empty seed is fatal upstream and is
 * never written, and `[]` would read back as a hit.
 */
export async function readSeed(domain: string, maxCompetitors: number): Promise<Company[] | null> {
    const kv = await getStore();
    const record = await kv.getValue<SeedRecord>(seedKey(domain, maxCompetitors));
    if (!record?.competitors?.length) return null;
    log.info('Competitor seed from cache', { domain, count: record.competitors.length, seededAt: record.seededAt });
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

/**
 * `Memory` plus the conditions it was gathered under, so the next run can notice it is
 * about to diff against a picture taken through a different lens and declare a baseline
 * instead of inventing `NEW` rows.
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
 * Returns `null` only when there is no memory at all — distinct from a record with empty
 * `slugs`, and from a pre-fingerprint record. The caller needs all three apart: no record
 * is a genuine first run, while a record with no fingerprint was written under unknown
 * conditions and must be treated as a baseline rather than silently diffed against.
 *
 * **Trap for whoever relaxes `companyDomain`'s lowercase-only input pattern.** This key
 * and `savePrevious`'s are built from the *raw* domain string, unlike everything else
 * downstream. That is safe only because the schema rejects uppercase today. The moment
 * `Apify.com` becomes valid input it gets its own memory record, rebaselines against
 * `apify.com`'s history, and reports a full page of `NEW`. Normalize with `sourceName` at
 * *both* ends of this pair in the same change, and note that existing records do not
 * migrate themselves.
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

export async function savePrevious(companyDomain: string, memory: StoredMemory, runDate: string): Promise<void> {
    const kv = await getStore();
    await kv.setValue(cacheKey('previous', companyDomain), { date: runDate, ...memory });
}
