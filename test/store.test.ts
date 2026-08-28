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
    log: { debug: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const {
    cacheKey,
    isExpired,
    loadPrevious,
    readIntegrations,
    readSeed,
    savePrevious,
    ttlHours,
    writeIntegrations,
    writeSeed,
} = await import('../src/store.js');

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
        expect(isExpired(hoursAgo(1), 24)).toBe(false);
    });

    it('is true once age exceeds the TTL', () => {
        expect(isExpired(hoursAgo(25), 24)).toBe(true);
    });

    it('treats TTL 0 as a forced expiry for any real past record', () => {
        const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
        expect(isExpired(oneSecondAgo, 0)).toBe(true);
    });
});

describe('readIntegrations / writeIntegrations', () => {
    beforeEach(() => {
        kvData.clear();
        delete process.env.CACHE_TTL_HOURS;
    });

    const NAMES = ['Slack', 'Notion'];

    it('round-trips a list of names', async () => {
        await writeIntegrations('rival.com', NAMES);
        expect(await readIntegrations('rival.com')).toEqual(NAMES);
    });

    it('returns null for a company that was never written', async () => {
        expect(await readIntegrations('never-written.com')).toBeNull();
    });

    it('keys per company, so two domains cannot read each other', async () => {
        await writeIntegrations('a.com', NAMES);
        expect(await readIntegrations('b.com')).toBeNull();
    });

    it('normalizes the domain so casing, scheme and www cannot fork the record', async () => {
        await writeIntegrations('https://www.Rival.com/integrations', NAMES);
        expect(await readIntegrations('rival.com')).toEqual(NAMES);
    });

    it('returns null once the record is past the 24h TTL', async () => {
        kvData.set(cacheKey('integrations', 'rival.com'), { fetchedAt: hoursAgo(25), names: NAMES });
        expect(await readIntegrations('rival.com')).toBeNull();
    });

    it('keeps a record still inside the 24h TTL', async () => {
        kvData.set(cacheKey('integrations', 'rival.com'), { fetchedAt: hoursAgo(23), names: NAMES });
        expect(await readIntegrations('rival.com')).toEqual(NAMES);
    });

    it('honours a CACHE_TTL_HOURS override, so a run can force a refresh', async () => {
        kvData.set(cacheKey('integrations', 'rival.com'), { fetchedAt: hoursAgo(1), names: NAMES });

        process.env.CACHE_TTL_HOURS = '0';
        expect(await readIntegrations('rival.com')).toBeNull();

        delete process.env.CACHE_TTL_HOURS;
        expect(await readIntegrations('rival.com')).toEqual(NAMES);
    });
});

describe('readSeed / writeSeed', () => {
    beforeEach(() => {
        kvData.clear();
        delete process.env.CACHE_TTL_HOURS;
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

    it('never expires, so a long gap between runs does not rebaseline', async () => {
        await savePrevious('apify.com', { slugs: ['clay'], sources: ['n8n.io'], fingerprint: 'fp-1' }, '2025-01-01');
        process.env.CACHE_TTL_HOURS = '0';

        expect(await loadPrevious('apify.com')).toEqual({ slugs: ['clay'], sources: ['n8n.io'], fingerprint: 'fp-1' });
        delete process.env.CACHE_TTL_HOURS;
    });
});
