import { describe, expect, it } from 'vitest';
import { computeGaps, diffAgainstPrevious, mapLimit, normalizeName } from '../src/pure.js';

describe('normalizeName', () => {
    it('lowercases and collapses punctuation', () => {
        expect(normalizeName('Google Sheets')).toBe('google-sheets');
        expect(normalizeName('  Google   Sheets  ')).toBe('google-sheets');
        expect(normalizeName('LangChain 🦜')).toBe('langchain');
    });

    it('strips decorative trailing words', () => {
        expect(normalizeName('Slack integration')).toBe('slack');
        expect(normalizeName('Airtable Connector')).toBe('airtable');
    });

    it('does not strip a word that is part of the real name', () => {
        expect(normalizeName('Cash App')).toBe('cash-app');
        expect(normalizeName('Google Apps')).toBe('google-apps');
    });

    it('resolves known aliases to one key', () => {
        expect(normalizeName('AWS S3')).toBe('amazon-s3');
        expect(normalizeName('S3')).toBe('amazon-s3');
        expect(normalizeName('Make.com')).toBe('make');
        expect(normalizeName('Make (formerly Integromat)')).toBe('make');
        expect(normalizeName('Postgres')).toBe('postgresql');
        expect(normalizeName('MS Teams')).toBe('microsoft-teams');
    });

    it('drops parenthetical qualifiers', () => {
        expect(normalizeName('Notion (via Zapier)')).toBe('notion');
    });
});

describe('computeGaps', () => {
    const sources = [
        { name: 'firecrawl.dev', kind: 'peer' as const, names: ['Weaviate', 'Slack', 'API'] },
        { name: 'zyte.com', kind: 'peer' as const, names: ['Weaviate'] },
        { name: 'n8n.io', kind: 'directory' as const, names: ['Weaviate', 'Clay'] },
    ];

    it('reports what sources carry and we do not', () => {
        expect(computeGaps(['slack'], sources, 1).map((c) => c.slug)).toContain('weaviate');
    });

    it('excludes what we already have', () => {
        expect(computeGaps(['weaviate'], sources, 1).map((c) => c.slug)).not.toContain('weaviate');
    });

    it('counts peers and directories separately', () => {
        const [top] = computeGaps([], sources, 1);
        expect(top.slug).toBe('weaviate');
        expect(top.peerCount).toBe(2);
        expect(top.directoryCount).toBe(1);
        expect(top.carriedBy).toEqual(['firecrawl.dev', 'zyte.com', 'n8n.io']);
    });

    it('drops generic stopwords that are not real integrations', () => {
        expect(computeGaps([], sources, 1).map((c) => c.slug)).not.toContain('api');
    });

    it('applies the minimum source threshold', () => {
        expect(computeGaps([], sources, 3).map((c) => c.slug)).toEqual(['weaviate']);
    });

    it('sorts by peer count first, then total sources', () => {
        const s = [
            { name: 'a.com', kind: 'peer' as const, names: ['rare'] },
            { name: 'b.com', kind: 'peer' as const, names: ['rare', 'common'] },
            { name: 'd1.io', kind: 'directory' as const, names: ['common'] },
            { name: 'd2.io', kind: 'directory' as const, names: ['common'] },
        ];
        expect(computeGaps([], s, 1).map((c) => c.slug)).toEqual(['rare', 'common']);
    });

    it('normalizes both sides before comparing', () => {
        const s = [{ name: 'x.com', kind: 'peer' as const, names: ['AWS S3'] }];
        expect(computeGaps(['Amazon S3'], s, 1)).toEqual([]);
    });
});

describe('diffAgainstPrevious', () => {
    it('marks everything NEW when there is no history', () => {
        const tags = diffAgainstPrevious([], ['weaviate', 'clay']);
        expect(tags.get('weaviate')).toBe('NEW');
    });

    it('marks previously reported candidates SEEN', () => {
        const tags = diffAgainstPrevious(['clay'], ['weaviate', 'clay']);
        expect(tags.get('weaviate')).toBe('NEW');
        expect(tags.get('clay')).toBe('SEEN');
    });

    it('does not resurrect candidates that have disappeared', () => {
        const tags = diffAgainstPrevious(['gone'], ['clay']);
        expect(tags.has('gone')).toBe(false);
    });
});

describe('mapLimit', () => {
    it('preserves input order regardless of completion order', async () => {
        const delays = [30, 5, 20, 1];
        const out = await mapLimit(delays, 2, async (d) => {
            await new Promise((r) => setTimeout(r, d));
            return d;
        });
        expect(out).toEqual(delays);
    });

    it('never exceeds the concurrency limit', async () => {
        let active = 0;
        let peak = 0;
        await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active -= 1;
            return null;
        });
        expect(peak).toBeLessThanOrEqual(2);
    });
});
