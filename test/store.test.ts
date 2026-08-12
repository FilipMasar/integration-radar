import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `readListPageVerdict`/`writeListPageVerdict` (and `writeCache`, used here to seed a
 * page record for them to attach to) go through `getStore()`, i.e. `Actor.
 * openKeyValueStore(...)`, so this file needs a fake key-value store. `cacheKey`/
 * `isExpired`/`ttlHours` above are pure and never touch `Actor`, so this mock is inert
 * for them. The fake is a plain `Map` behind `getValue`/`setValue` — enough to exercise
 * "attach to an existing record" / "no record yet" / "TTL expiry", the actual contracts
 * these functions promise.
 */
const kvData = new Map<string, unknown>();

vi.mock('apify', () => ({
    Actor: {
        openKeyValueStore: vi.fn(async () => ({
            getValue: async (key: string) => kvData.get(key) ?? null,
            setValue: async (key: string, value: unknown) => {
                kvData.set(key, value);
            },
        })),
    },
    log: { info: vi.fn(), warning: vi.fn() },
}));

const { cacheKey, isExpired, readListPageVerdict, ttlHours, writeCache, writeListPageVerdict } = await import(
    '../src/store.js'
);

describe('cacheKey', () => {
    it('strips the scheme', () => {
        expect(cacheKey('page', 'https://apify.com/integrations')).toBe('page-apify-com-integrations');
    });

    it('maps a trailing-slash URL and its bare form to the same key', () => {
        const withSlash = cacheKey('page', 'https://apify.com/integrations/');
        const bare = cacheKey('page', 'https://apify.com/integrations');
        expect(withSlash).toBe(bare);
    });

    it('collapses non-alphanumeric runs into a single dash', () => {
        expect(cacheKey('search', 'brightdata.com-integrations')).toBe('search-brightdata-com-integrations');
    });

    it('truncates to a safe key-length ceiling', () => {
        const long = `https://example.com/${'a'.repeat(300)}`;
        const key = cacheKey('page', long);
        expect(key.length).toBeLessThanOrEqual('page-'.length + 190);
    });
});

describe('ttlHours', () => {
    it('parses a numeric override, including 0 for forced expiry', () => {
        expect(ttlHours('0', 24)).toBe(0);
        expect(ttlHours('6', 24)).toBe(6);
    });

    it('falls back to the default on a missing value', () => {
        expect(ttlHours(undefined, 24)).toBe(24);
    });

    it('falls back to the default on an unparseable value instead of yielding NaN', () => {
        const result = ttlHours('abc', 24);
        expect(result).toBe(24);
        expect(Number.isNaN(result)).toBe(false);
    });
});

describe('isExpired', () => {
    it('is false for a record within the TTL window', () => {
        const oneHourAgo = new Date(Date.now() - 1 * 3_600_000).toISOString();
        expect(isExpired(oneHourAgo, 24)).toBe(false);
    });

    it('is true once age exceeds the TTL', () => {
        const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
        expect(isExpired(twentyFiveHoursAgo, 24)).toBe(true);
    });

    it('treats TTL 0 as a forced expiry for any real past record', () => {
        const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
        expect(isExpired(oneSecondAgo, 0)).toBe(true);
    });
});

describe('readListPageVerdict / writeListPageVerdict', () => {
    beforeEach(() => {
        kvData.clear();
    });

    it('returns null when there is no page record at all', async () => {
        expect(await readListPageVerdict('no-such-key')).toBeNull();
    });

    it('returns null — not false — when the page record exists but was never gated', async () => {
        await writeCache('key-ungated', { url: 'https://example.com', markdown: 'hi' });
        expect(await readListPageVerdict('key-ungated')).toBeNull();
    });

    it('round-trips a true verdict', async () => {
        await writeCache('key-true', { url: 'https://example.com', markdown: 'hi' });
        await writeListPageVerdict('key-true', true);
        expect(await readListPageVerdict('key-true')).toBe(true);
    });

    it('round-trips a false verdict distinctly from "never gated"', async () => {
        // The bug this guards against: an earlier draft could have used `record.isListPage`
        // as a truthy check, which cannot tell a cached `false` apart from "no verdict yet"
        // and would silently re-run the LLM gate on every rejected page forever.
        await writeCache('key-false', { url: 'https://example.com', markdown: 'hi' });
        await writeListPageVerdict('key-false', false);
        expect(await readListPageVerdict('key-false')).toBe(false);
    });

    it('never attaches a verdict to a page record that does not exist', async () => {
        await writeListPageVerdict('never-fetched', true);
        expect(await readListPageVerdict('never-fetched')).toBeNull();
    });

    it('expires the verdict on the same TTL as the page record it is attached to', async () => {
        const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
        kvData.set('key-stale', {
            fetchedAt: twentyFiveHoursAgo,
            hit: { url: 'https://example.com', markdown: 'hi' },
            isListPage: true,
        });
        expect(await readListPageVerdict('key-stale')).toBeNull();
    });
});
