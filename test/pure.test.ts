import { describe, expect, it } from 'vitest';
import {
    diffAgainstPrevious,
    inputFingerprint,
    mapLimit,
    mergeMemory,
    normalizeCompetitors,
    normalizeName,
    rankCandidates,
    sourceName,
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

describe('sourceName', () => {
    it('reduces a full URL and a bare domain to the same name', () => {
        expect(sourceName('https://zapier.com/apps')).toBe('zapier.com');
        expect(sourceName('zapier.com')).toBe('zapier.com');
    });

    it('folds www. so make.com and www.make.com are one source, not two', () => {
        expect(sourceName('https://www.make.com/en/integrations')).toBe('make.com');
        expect(sourceName('make.com')).toBe('make.com');
    });

    it('keeps a real subdomain, which is a genuinely different source', () => {
        expect(sourceName('https://docs.llamaindex.ai/en/stable/')).toBe('docs.llamaindex.ai');
    });

    it('drops scheme, port, query and fragment', () => {
        expect(sourceName('HTTPS://Example.com:8443/a/b?c=d#e')).toBe('example.com');
    });
});

describe('normalizeCompetitors', () => {
    it('normalizes a domain carrying a scheme, path and www', () => {
        expect(normalizeCompetitors([{ name: 'Jina AI', domain: 'https://www.jina.ai/pricing' }])).toEqual([
            { name: 'Jina AI', domain: 'jina.ai' },
        ]);
    });

    it('drops an entry with an empty domain rather than deriving one from the name', () => {
        expect(normalizeCompetitors([{ name: 'Import.io', domain: '' }])).toEqual([]);
    });

    it('drops an entry whose domain is not a domain', () => {
        expect(normalizeCompetitors([{ name: 'Bad', domain: 'not a domain' }])).toEqual([]);
        expect(normalizeCompetitors([{ name: 'Bad', domain: 'notadomain' }])).toEqual([]);
    });

    it('deduplicates entries that share a domain, keeping the first', () => {
        expect(
            normalizeCompetitors([
                { name: 'Make', domain: 'make.com' },
                { name: 'Make.com', domain: 'https://make.com/en' },
            ]),
        ).toEqual([{ name: 'Make', domain: 'make.com' }]);
    });

    it('trims the name', () => {
        expect(normalizeCompetitors([{ name: '  Rival  ', domain: 'rival.com' }])[0].name).toBe('Rival');
    });
});

describe('rankCandidates', () => {
    const sources = [
        { name: 'a.com', names: ['two-source', 'one-source'] },
        { name: 'b.com', names: ['two-source'] },
    ];

    it('keeps a candidate carried by a single competitor — there is no evidence threshold', () => {
        expect(rankCandidates([], sources).map((c) => c.slug)).toEqual(['two-source', 'one-source']);
    });

    const mixedSources = [
        { name: 'firecrawl.dev', names: ['Weaviate', 'Slack', 'API'] },
        { name: 'zyte.com', names: ['Weaviate'] },
        { name: 'n8n.io', names: ['Weaviate', 'Clay'] },
    ];

    it('excludes generic stopwords that are not real integrations', () => {
        expect(rankCandidates([], mixedSources).map((c) => c.slug)).not.toContain('api');
    });

    it('counts every competitor carrying a name and cites each one in carriedBy', () => {
        const [top] = rankCandidates([], mixedSources);
        expect(top.slug).toBe('weaviate');
        expect(top.competitorCount).toBe(3);
        expect(top.carriedBy).toEqual(['firecrawl.dev', 'zyte.com', 'n8n.io']);
    });

    it('counts one competitor once however many times it repeats a name', () => {
        const s = [{ name: 'a.com', names: ['Slack', 'Slack integration', 'slack'] }];
        const [top] = rankCandidates([], s);
        expect(top.competitorCount).toBe(1);
        expect(top.carriedBy).toEqual(['a.com']);
    });

    it('excludes candidates with cross-alias ownership normalization', () => {
        const s = [{ name: 'x.com', names: ['AWS S3'] }];
        expect(rankCandidates(['Amazon S3'], s)).toEqual([]);
    });

    it('sorts by competitor count, most-carried first', () => {
        const s = [
            { name: 'a.com', names: ['rare'] },
            { name: 'b.com', names: ['rare', 'common'] },
        ];
        expect(rankCandidates([], s).map((c) => c.slug)).toEqual(['rare', 'common']);
    });

    it('breaks a count tie alphabetically, so the order is stable between runs', () => {
        const s = [{ name: 'a.com', names: ['zzz-last', 'aaa-first'] }];
        const ranked = rankCandidates([], s);
        expect(ranked.map((c) => c.competitorCount)).toEqual([1, 1]);
        expect(ranked.map((c) => c.slug)).toEqual(['aaa-first', 'zzz-last']);
    });
});

describe('inputFingerprint', () => {
    const base = { companyDomain: 'apify.com', maxCompetitors: 20 };

    it('changes when maxCompetitors changes', () => {
        expect(inputFingerprint({ ...base, maxCompetitors: 10 })).not.toBe(inputFingerprint(base));
    });

    it('normalizes the company domain, so www and casing are not a different question', () => {
        expect(inputFingerprint({ ...base, companyDomain: 'https://WWW.Apify.com/' })).toBe(inputFingerprint(base));
    });

    it('changes when a competitor set is present at all', () => {
        expect(inputFingerprint({ ...base, competitors: ['rival.com'] })).not.toBe(inputFingerprint(base));
    });

    it('changes when one competitor is swapped for another', () => {
        expect(inputFingerprint({ ...base, competitors: ['a.com', 'b.com'] })).not.toBe(
            inputFingerprint({ ...base, competitors: ['a.com', 'c.com'] }),
        );
    });

    it('does not change when the same competitors are reordered or duplicated', () => {
        expect(inputFingerprint({ ...base, competitors: ['a.com', 'b.com'] })).toBe(
            inputFingerprint({ ...base, competitors: ['b.com', 'a.com', 'a.com'] }),
        );
    });

    it('normalizes competitor spellings, so www and casing are not a different question', () => {
        expect(inputFingerprint({ ...base, competitors: ['https://www.A.com/x'] })).toBe(
            inputFingerprint({ ...base, competitors: ['a.com'] }),
        );
    });
});

describe('mergeMemory', () => {
    const mem = (slugs: string[], sources: string[]) => ({ slugs, sources });

    it('replaces memory when this run covered every source memory rests on', () => {
        const { memory, replaced } = mergeMemory(
            mem(['a', 'b'], ['x.com']),
            mem(['b', 'c'], ['x.com', 'y.com']),
            false,
        );
        expect(replaced).toBe(true);
        expect(memory.slugs).toEqual(['b', 'c']);
    });

    it('unions when a source memory rests on did not resolve this run', () => {
        const { memory, replaced } = mergeMemory(mem(['a', 'b'], ['x.com', 'flaky.com']), mem(['b'], ['x.com']), false);
        expect(replaced).toBe(false);
        expect(new Set(memory.slugs)).toEqual(new Set(['a', 'b']));
        expect(new Set(memory.sources)).toEqual(new Set(['x.com', 'flaky.com']));
    });

    it('unions when a source was never attempted, not merely unresolved', () => {
        const { memory, replaced } = mergeMemory(
            mem(['a', 'b'], ['x.com', 'dropped.com']),
            mem(['b'], ['x.com']),
            false,
        );
        expect(replaced).toBe(false);
        expect(memory.slugs).toContain('a');
    });

    it('does not duplicate slugs or sources present on both sides', () => {
        const { memory } = mergeMemory(mem(['a'], ['x.com', 'flaky.com']), mem(['a'], ['x.com']), false);
        expect(memory.slugs).toEqual(['a']);
        expect(memory.sources).toEqual(['x.com', 'flaky.com']);
    });

    it('treats an empty previous basis as covered — a first run replaces', () => {
        const { memory, replaced } = mergeMemory(mem([], []), mem(['a'], ['x.com']), false);
        expect(replaced).toBe(true);
        expect(memory).toEqual({ slugs: ['a'], sources: ['x.com'] });
    });

    it('never drops slugs when the inputs changed, but resets the basis to this run', () => {
        const { memory, replaced } = mergeMemory(mem(['a'], ['old.com']), mem(['b'], ['new.com']), true);
        expect(replaced).toBe(false);
        expect(new Set(memory.slugs)).toEqual(new Set(['a', 'b']));
        expect(memory.sources).toEqual(['new.com']);
    });

    it('end to end: a flaky source never produces a spurious second NEW', () => {
        let memory = mem([], []);

        let current = mem(['brightdata-candidate', 'stable-candidate'], ['brightdata.com', 'stable.com']);
        let tags = diffAgainstPrevious(memory.slugs, current.slugs);
        expect(tags.get('brightdata-candidate')).toBe('NEW');
        memory = mergeMemory(memory, current, false).memory;

        current = mem(['stable-candidate'], ['stable.com']);
        tags = diffAgainstPrevious(memory.slugs, current.slugs);
        expect(tags.get('stable-candidate')).toBe('SEEN');
        memory = mergeMemory(memory, current, false).memory;
        expect(memory.slugs).toContain('brightdata-candidate');

        current = mem(['brightdata-candidate', 'stable-candidate'], ['brightdata.com', 'stable.com']);
        tags = diffAgainstPrevious(memory.slugs, current.slugs);
        expect(tags.get('brightdata-candidate')).toBe('SEEN');
    });

    it('end to end: a removal survives one blind run and then genuinely drops out', () => {
        let memory = mem(['gone', 'kept'], ['peer.com', 'dir.io']);

        memory = mergeMemory(memory, mem(['kept'], ['peer.com']), false).memory;
        expect(memory.slugs).toContain('gone');

        const merged = mergeMemory(memory, mem(['kept'], ['peer.com', 'dir.io']), false);
        expect(merged.replaced).toBe(true);
        expect(merged.memory.slugs).not.toContain('gone');
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
