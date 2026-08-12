import { describe, expect, it } from 'vitest';
import {
    computeGaps,
    diffAgainstPrevious,
    mapLimit,
    mergePreviousSlugs,
    normalizeName,
    partitionResolved,
} from '../src/pure.js';

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

describe('partitionResolved', () => {
    it('keeps only the non-null results', () => {
        const { items } = partitionResolved([1, null, 2, null, 3]);
        expect(items).toEqual([1, 2, 3]);
    });

    it('reports full coverage when nothing is null', () => {
        expect(partitionResolved([1, 2, 3]).fullCoverage).toBe(true);
    });

    it('reports incomplete coverage when even one item is null', () => {
        expect(partitionResolved([1, null, 3]).fullCoverage).toBe(false);
    });

    it('treats an empty list as full coverage — there is nothing left unresolved', () => {
        expect(partitionResolved([]).fullCoverage).toBe(true);
    });
});

describe('mergePreviousSlugs', () => {
    it('replaces memory outright on full coverage, dropping what genuinely disappeared', () => {
        // This is the behavior a naive `savePrevious(currentSlugs)` also gets right —
        // the point of this test is to confirm fullCoverage=true does not carry forward.
        expect(mergePreviousSlugs(['a', 'b'], ['b', 'c'], true)).toEqual(['b', 'c']);
    });

    it('carries forward a slug missing from this run when coverage was incomplete', () => {
        // The exact bug this rule targets: a naive `mergePreviousSlugs` that always
        // returns `currentSlugs` (i.e. ignores `fullCoverage`) would return ['b'] here,
        // silently forgetting 'a' even though nothing proved it was gone.
        const merged = mergePreviousSlugs(['a', 'b'], ['b'], false);
        expect(new Set(merged)).toEqual(new Set(['a', 'b']));
    });

    it('does not duplicate a slug present in both previous and current', () => {
        const merged = mergePreviousSlugs(['a'], ['a'], false);
        expect(merged).toEqual(['a']);
    });

    it('is not fooled by an empty previous run', () => {
        expect(new Set(mergePreviousSlugs([], ['a', 'b'], false))).toEqual(new Set(['a', 'b']));
    });

    it('end to end: a flaky source never produces a spurious second NEW', () => {
        // Simulates the measured scenario: brightdata.com resolves, then fails to
        // resolve, then resolves again, across three runs of an otherwise-unchanged
        // candidate set.
        let memory: string[] = [];

        // Run 1: full coverage, baseline.
        let current = ['brightdata-candidate', 'stable-candidate'];
        let tags = diffAgainstPrevious(memory, current);
        expect(tags.get('brightdata-candidate')).toBe('NEW');
        memory = mergePreviousSlugs(memory, current, true);

        // Run 2: brightdata.com fails to resolve, so its candidate drops out of this
        // run's evidence. Coverage is incomplete.
        current = ['stable-candidate'];
        tags = diffAgainstPrevious(memory, current);
        expect(tags.get('stable-candidate')).toBe('SEEN');
        memory = mergePreviousSlugs(memory, current, false);
        expect(memory).toContain('brightdata-candidate'); // carried forward, not erased

        // Run 3: brightdata.com resolves again. A naive implementation that overwrote
        // memory in run 2 would tag this NEW a second time; it must read SEEN.
        current = ['brightdata-candidate', 'stable-candidate'];
        tags = diffAgainstPrevious(memory, current);
        expect(tags.get('brightdata-candidate')).toBe('SEEN');
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
