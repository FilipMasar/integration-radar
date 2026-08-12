import { describe, expect, it } from 'vitest';
import {
    diffAgainstPrevious,
    inputFingerprint,
    mapLimit,
    mergeMemory,
    normalizeName,
    partitionResolved,
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

describe('sourceName', () => {
    it('reduces a directory URL and a competitor domain to the same namespace', () => {
        // The collision that made `zapier.com` count twice toward minSources: one code
        // path minted `new URL(url).hostname`, the other `competitor.domain`.
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

describe('rankCandidates', () => {
    const sources = [
        { name: 'a.com', kind: 'peer' as const, names: ['two-source', 'one-source'] },
        { name: 'b.com', kind: 'peer' as const, names: ['two-source'] },
    ];

    it('keeps candidates below any threshold — it is the memory pool', () => {
        // The bug: applying `minSources` before memory is computed. A user who raises
        // minSources to 3 and back to 2 (the README recommends the tuning) would then
        // get every 2-source candidate back as fabricated NEW.
        expect(rankCandidates([], sources).map((c) => c.slug)).toEqual(['two-source', 'one-source']);
    });

    it('excludes generic stopwords that are not real integrations', () => {
        const s = [
            { name: 'firecrawl.dev', kind: 'peer' as const, names: ['Weaviate', 'Slack', 'API'] },
            { name: 'zyte.com', kind: 'peer' as const, names: ['Weaviate'] },
            { name: 'n8n.io', kind: 'directory' as const, names: ['Weaviate', 'Clay'] },
        ];
        expect(rankCandidates([], s).map((c) => c.slug)).not.toContain('api');
    });

    it('excludes candidates with cross-alias ownership normalization', () => {
        const s = [{ name: 'x.com', kind: 'peer' as const, names: ['AWS S3'] }];
        expect(rankCandidates(['Amazon S3'], s)).toEqual([]);
    });

    it('sorts by peer count first, then directory count as tie-breaker', () => {
        const s = [
            { name: 'a.com', kind: 'peer' as const, names: ['rare'] },
            { name: 'b.com', kind: 'peer' as const, names: ['rare', 'common'] },
            { name: 'd1.io', kind: 'directory' as const, names: ['common'] },
            { name: 'd2.io', kind: 'directory' as const, names: ['common'] },
        ];
        expect(rankCandidates([], s).map((c) => c.slug)).toEqual(['rare', 'common']);
    });
});

describe('inputFingerprint', () => {
    const base = { companyDomain: 'apify.com', maxCompetitors: 20, directories: ['https://zapier.com/apps'] };

    it('is stable across reordering and trailing-slash differences in directories', () => {
        const one = inputFingerprint({ ...base, directories: ['https://a.com/x/', 'https://b.com/y'] });
        const two = inputFingerprint({ ...base, directories: ['https://b.com/y', 'https://A.com/x'] });
        expect(one).toBe(two);
    });

    it('changes when maxCompetitors changes', () => {
        expect(inputFingerprint({ ...base, maxCompetitors: 10 })).not.toBe(inputFingerprint(base));
    });

    it('changes when the directory list changes', () => {
        expect(inputFingerprint({ ...base, directories: ['https://n8n.io/integrations/'] })).not.toBe(
            inputFingerprint(base),
        );
    });

    it('does NOT depend on minSources — memory holds the unfiltered pool, so it cannot move a slug', () => {
        // Guards against someone "helpfully" adding minSources to the fingerprint: that
        // would force a pointless BASELINE run every time a user turns the noise knob.
        const loose = { ...base, minSources: 2 };
        const strict = { ...base, minSources: 9 };
        expect(inputFingerprint(loose)).toBe(inputFingerprint(strict));
    });
});

describe('mergeMemory', () => {
    const mem = (slugs: string[], sources: string[]) => ({ slugs, sources });

    it('replaces memory when this run covered every source memory rests on', () => {
        const { memory, replaced } = mergeMemory(mem(['a', 'b'], ['x.com']), mem(['b', 'c'], ['x.com', 'y.com']), false);
        expect(replaced).toBe(true);
        expect(memory.slugs).toEqual(['b', 'c']); // 'a' genuinely disappeared and drops out
    });

    it('unions when a source memory rests on did not resolve this run', () => {
        // The measured scenario: brightdata.com resolved last run, not this one. A naive
        // merge would forget its candidates and re-tag them NEW when it comes back.
        const { memory, replaced } = mergeMemory(mem(['a', 'b'], ['x.com', 'flaky.com']), mem(['b'], ['x.com']), false);
        expect(replaced).toBe(false);
        expect(new Set(memory.slugs)).toEqual(new Set(['a', 'b']));
        // The basis accumulates, so flaky.com stays part of what memory rests on.
        expect(new Set(memory.sources)).toEqual(new Set(['x.com', 'flaky.com']));
    });

    it('unions when a source was never attempted, not merely unresolved', () => {
        // THE critical hole: a competitor dropped before the resolution loop (model
        // nondeterminism, a maxCompetitors cut, a shorter directories list) never shows
        // up as an unresolved entry, so the old `fullCoverage` gate read "complete" and
        // replaced memory. Comparing evidence bases sees it.
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
        // The caller reports this run as a baseline, so no NEW is shown; keeping the old
        // slugs protects the run AFTER it, and resetting the basis stops the abandoned
        // configuration's sources from freezing memory forever.
        const { memory, replaced } = mergeMemory(mem(['a'], ['old.com']), mem(['b'], ['new.com']), true);
        expect(replaced).toBe(false);
        expect(new Set(memory.slugs)).toEqual(new Set(['a', 'b']));
        expect(memory.sources).toEqual(['new.com']);
    });

    it('end to end: a flaky source never produces a spurious second NEW', () => {
        // Simulates the measured scenario: brightdata.com resolves, then fails to
        // resolve, then resolves again, across three runs of an otherwise-unchanged
        // candidate set.
        let memory = mem([], []);

        // Run 1: both sources read, baseline.
        let current = mem(['brightdata-candidate', 'stable-candidate'], ['brightdata.com', 'stable.com']);
        let tags = diffAgainstPrevious(memory.slugs, current.slugs);
        expect(tags.get('brightdata-candidate')).toBe('NEW');
        memory = mergeMemory(memory, current, false).memory;

        // Run 2: brightdata.com fails to resolve, so its candidate drops out of this
        // run's evidence and out of this run's evidence base.
        current = mem(['stable-candidate'], ['stable.com']);
        tags = diffAgainstPrevious(memory.slugs, current.slugs);
        expect(tags.get('stable-candidate')).toBe('SEEN');
        memory = mergeMemory(memory, current, false).memory;
        expect(memory.slugs).toContain('brightdata-candidate'); // carried forward, not erased

        // Run 3: brightdata.com resolves again. A naive implementation that overwrote
        // memory in run 2 would tag this NEW a second time; it must read SEEN.
        current = mem(['brightdata-candidate', 'stable-candidate'], ['brightdata.com', 'stable.com']);
        tags = diffAgainstPrevious(memory.slugs, current.slugs);
        expect(tags.get('brightdata-candidate')).toBe('SEEN');
    });

    it('end to end: a removal survives one blind run and then genuinely drops out', () => {
        // The property `mergeMemory`'s doc comment claims, which the old `fullCoverage`
        // gate did not actually have: it required ALL 20 competitors to resolve and so
        // essentially never fired, and memory only ever grew.
        let memory = mem(['gone', 'kept'], ['peer.com', 'dir.io']);

        // A blind run (dir.io down) must NOT drop 'gone' — no evidence it went anywhere.
        memory = mergeMemory(memory, mem(['kept'], ['peer.com']), false).memory;
        expect(memory.slugs).toContain('gone');

        // The next run reads both sources again: now 'gone' really is gone.
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
