import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const {
    cacheKey,
    isExpired,
    loadPrevious,
    readCache,
    readListPageVerdict,
    readMiss,
    readNames,
    readSeed,
    savePrevious,
    ttlHours,
    writeCache,
    writeListPageVerdict,
    writeMiss,
    writeNames,
    writeSeed,
} = await import('../src/store.js');

const PAGE = { url: 'https://example.com/integrations', markdown: 'hello' };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

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

describe('readCache / writeCache', () => {
    beforeEach(() => {
        kvData.clear();
        delete process.env.CACHE_TTL_HOURS;
    });

    it('round-trips a page', async () => {
        await writeCache('page-key', PAGE);
        expect(await readCache('page-key')).toEqual(PAGE);
    });

    it('returns null for a key that was never written', async () => {
        expect(await readCache('never-written')).toBeNull();
    });

    it('returns null once the page is past the 24h TTL', async () => {
        kvData.set('stale', { fetchedAt: hoursAgo(25), hit: PAGE });
        expect(await readCache('stale')).toBeNull();
    });

    it('drops the extracted names and the gate verdict when the page is refetched', async () => {
        await writeCache('key', PAGE);
        await writeNames('key', ['Old Name']);
        await writeListPageVerdict('key', true);

        await writeCache('key', { url: PAGE.url, markdown: 'completely different content' });

        expect(await readNames('key')).toBeNull();
        expect(await readListPageVerdict('key')).toBeNull();
        expect(await readCache('key')).toEqual({ url: PAGE.url, markdown: 'completely different content' });
    });
});

describe('readNames / writeNames', () => {
    beforeEach(() => {
        kvData.clear();
        delete process.env.CACHE_TTL_HOURS;
    });

    it('round-trips names attached to an existing page record', async () => {
        await writeCache('key', PAGE);
        await writeNames('key', ['Slack', 'Notion']);
        expect(await readNames('key')).toEqual(['Slack', 'Notion']);
    });

    it('never attaches names to a page record that does not exist', async () => {
        await writeNames('orphan', ['Slack']);
        expect(await readNames('orphan')).toBeNull();
        expect(await readCache('orphan')).toBeNull();
    });

    it('expires the names on the same TTL as the page they came from', async () => {
        kvData.set('stale', { fetchedAt: hoursAgo(25), hit: PAGE, names: ['Slack'] });
        expect(await readNames('stale')).toBeNull();
    });
});

describe('readMiss / writeMiss', () => {
    beforeEach(() => {
        kvData.clear();
        delete process.env.CACHE_TTL_HOURS;
        delete process.env.MISS_TTL_HOURS;
    });

    it('round-trips a miss under its own key, never inside the page record', async () => {
        await writeMiss('key');
        expect(await readMiss('key')).toBe(true);
        expect(await readCache('key')).toBeNull();
    });

    it('is false for a key that never missed', async () => {
        expect(await readMiss('never')).toBe(false);
    });

    it('reads the 6h miss TTL, not the 24h page TTL', async () => {
        kvData.set('key-miss', { missedAt: hoursAgo(10) });
        kvData.set('key', { fetchedAt: hoursAgo(10), hit: PAGE });

        expect(await readMiss('key')).toBe(false);
        expect(await readCache('key')).toEqual(PAGE);
    });

    it('honours MISS_TTL_HOURS and CACHE_TTL_HOURS independently', async () => {
        kvData.set('key-miss', { missedAt: hoursAgo(1) });
        kvData.set('key', { fetchedAt: hoursAgo(1), hit: PAGE });

        process.env.CACHE_TTL_HOURS = '0';
        expect(await readCache('key')).toBeNull();
        expect(await readMiss('key')).toBe(true);

        delete process.env.CACHE_TTL_HOURS;
        process.env.MISS_TTL_HOURS = '0';
        expect(await readMiss('key')).toBe(false);
        expect(await readCache('key')).toEqual(PAGE);
        delete process.env.MISS_TTL_HOURS;
    });
});

describe('readSeed / writeSeed', () => {
    beforeEach(() => {
        kvData.clear();
        delete process.env.CACHE_TTL_HOURS;
        delete process.env.MISS_TTL_HOURS;
    });

    const RIVALS = [{ name: 'Rival', domain: 'rival.com' }];

    it('round-trips a seed', async () => {
        await writeSeed('mine.com', 20, RIVALS);
        expect(await readSeed('mine.com', 20)).toEqual(RIVALS);
    });

    it('returns null when nothing is stored', async () => {
        expect(await readSeed('never-seeded.com', 20)).toBeNull();
    });

    it('never expires, however old the record is', async () => {
        await writeSeed('ancient.com', 20, RIVALS);
        const key = [...kvData.keys()].find((k) => k.includes('ancient-com'))!;
        kvData.set(key, { seededAt: hoursAgo(24 * 365), competitors: RIVALS });

        expect(await readSeed('ancient.com', 20)).toEqual(RIVALS);
    });

    it('never writes an empty seed', async () => {
        await writeSeed('empty.com', 20, []);
        expect([...kvData.keys()].some((k) => k.includes('empty-com'))).toBe(false);
        expect(await readSeed('empty.com', 20)).toBeNull();
    });

    it('keys separately per maxCompetitors', async () => {
        await writeSeed('mine.com', 5, RIVALS);
        expect(await readSeed('mine.com', 5)).toEqual(RIVALS);
        expect(await readSeed('mine.com', 6)).toBeNull();
    });

    it('normalizes the domain so casing and www cannot fork the record', async () => {
        await writeSeed('https://www.Mine.com/', 20, RIVALS);
        expect(await readSeed('mine.com', 20)).toEqual(RIVALS);
    });
});

describe('loadPrevious / savePrevious', () => {
    beforeEach(() => {
        kvData.clear();
    });

    it('returns null when nothing has ever been stored', async () => {
        expect(await loadPrevious('apify.com')).toBeNull();
    });

    it('round-trips slugs, the evidence base and the input fingerprint', async () => {
        await savePrevious('apify.com', { slugs: ['clay'], sources: ['n8n.io'], fingerprint: 'fp-1' }, '2026-08-11');
        expect(await loadPrevious('apify.com')).toEqual({ slugs: ['clay'], sources: ['n8n.io'], fingerprint: 'fp-1' });
    });

    it('keys memory per company, so two domains cannot read each other', async () => {
        await savePrevious('a.com', { slugs: ['x'], sources: [], fingerprint: 'fp' }, '2026-08-11');
        expect(await loadPrevious('b.com')).toBeNull();
    });

    it('reads a pre-fingerprint record as fingerprint null, not as a match', async () => {
        kvData.set(cacheKey('previous', 'apify.com'), { date: '2026-08-10', slugs: ['clay'] });
        expect(await loadPrevious('apify.com')).toEqual({ slugs: ['clay'], sources: [], fingerprint: null });
    });
});
