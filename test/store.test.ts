import { describe, expect, it } from 'vitest';
import { cacheKey, isExpired, ttlHours } from '../src/store.js';

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
