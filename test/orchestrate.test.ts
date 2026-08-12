import { describe, expect, it, vi } from 'vitest';
import type { Company, ListKind, PageHit } from '../src/pure.js';
import type { Resolved } from '../src/web.js';
// Type-only import: erased at compile time, so it needs no involvement from the
// `apify` mock below or from the dynamic `import()` used for the runtime value.
import type { Deps, Input } from '../src/orchestrate.js';

/**
 * Fix round 1, Important finding #2: `runIntegrationRadar`'s pure helpers
 * (`mergePreviousSlugs`, `partitionResolved`) were well tested in `pure.test.ts`, but
 * nothing exercised whether `main.ts` actually *called* them correctly — a reversion of
 * the `confirmed()` gate, or of the `savePrevious` call site back to the brief's own
 * original `gaps.map((g) => g.slug)`, would have passed all 91 tests that existed
 * before this file. `orchestrate.ts` splits that wiring into an exported,
 * dependency-injected function specifically so it can be driven directly here, with
 * fake `Deps` and no module mocking beyond `apify`'s `log` (stubbed only because these
 * tests run without `Actor.init()`, same as `llm.test.ts`).
 */
vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn() },
}));

const { runIntegrationRadar } = await import('../src/orchestrate.js');

function hit(url: string, markdown = '# page'): PageHit {
    return { url, markdown };
}

function resolved(overrides: Partial<Resolved> = {}): Resolved {
    return { hit: hit('https://example.com/integrations'), fromCache: false, key: 'key', tier: 'path', ...overrides };
}

// A single fixed placeholder directory URL, always present in `Input`. Production's
// `input.directories?.length ? input.directories : DEFAULT_DIRECTORIES` means an empty
// array is not "no directories" — it means "use the real seven-URL default list" — so
// these tests supply one explicit, controlled URL instead of coupling to that constant.
const FAKE_DIRECTORY = 'https://dir.test/integrations';

const BASE_INPUT: Input = {
    companyDomain: 'mine.com',
    maxCompetitors: 20,
    directories: [FAKE_DIRECTORY],
    minSources: 1,
};

/**
 * A minimal, fully-wired fake `Deps`: one competitor ("rival.com"), one directory (the
 * fixed placeholder above, unresolved by default so it never *accidentally* becomes a
 * source), every other call succeeds. Each test overrides only the handful of fields it
 * needs to exercise a specific behavior — the rest keep the pipeline running end to end
 * so the scenario under test isn't drowned in unrelated setup.
 */
function baseDeps(overrides: Partial<Deps> = {}): Deps {
    const altHit = hit('https://mine.com/alternatives');
    const ownHit = hit('https://mine.com/integrations');
    const rivalHit = hit('https://rival.com/integrations');

    const base: Deps = {
        findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
            if (domain === 'mine.com' && kind === 'alternatives') return resolved({ hit: altHit, key: 'alt' });
            if (domain === 'mine.com' && kind === 'integrations') return resolved({ hit: ownHit, key: 'own' });
            if (domain === 'rival.com' && kind === 'integrations') return resolved({ hit: rivalHit, key: 'rival' });
            return resolved({ hit: null, key: `${domain}-${kind}` });
        }),
        // Unresolved by default: a test that wants the directory to count toward
        // `fullCoverage` overrides this explicitly, so its contribution is never
        // accidental.
        fetchUrl: vi.fn(async (): Promise<Resolved> => resolved({ hit: null, key: 'fake-directory' })),
        extractCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Rival', domain: 'rival.com' }]),
        extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
            if (page.url === ownHit.url) return ['Existing Thing'];
            if (page.url === rivalHit.url) return ['Candidate One'];
            return [];
        }),
        isListPage: vi.fn(async () => true),
        describeCandidates: vi.fn(async () => new Map()),
        readNames: vi.fn(async () => null),
        writeNames: vi.fn(async () => undefined),
        readListPageVerdict: vi.fn(async () => null),
        writeListPageVerdict: vi.fn(async () => undefined),
        loadPrevious: vi.fn(async () => []),
        savePrevious: vi.fn(async () => undefined),
        pushData: vi.fn(async () => undefined),
        charge: vi.fn(async () => undefined),
    };
    return { ...base, ...overrides };
}

describe('runIntegrationRadar — requirement 1: gate search-tier hits, not path-tier hits', () => {
    it('calls isListPage for a search-tier hit and not for a path-tier hit', async () => {
        const altHit = hit('https://mine.com/alternatives');
        const ownHit = hit('https://mine.com/integrations');
        const pathHit = hit('https://rival.com/integrations'); // resolves via the path tier
        const searchHit = hit('https://searchfound.com/some-other-page'); // resolves via search

        const isListPageSpy = vi.fn(async () => true);

        const deps = baseDeps({
            isListPage: isListPageSpy,
            extractCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Rival', domain: 'rival.com' },
                { name: 'SearchFound', domain: 'searchfound.com' },
            ]),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') return resolved({ hit: altHit, key: 'alt', tier: 'path' });
                if (domain === 'mine.com' && kind === 'integrations') return resolved({ hit: ownHit, key: 'own', tier: 'path' });
                if (domain === 'rival.com') return resolved({ hit: pathHit, key: 'rival', tier: 'path' });
                if (domain === 'searchfound.com') return resolved({ hit: searchHit, key: 'search-hit', tier: 'search' });
                return resolved({ hit: null, key: `${domain}-${kind}` });
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url === ownHit.url) return ['Existing Thing'];
                if (page.url === pathHit.url) return ['From Path'];
                if (page.url === searchHit.url) return ['From Search'];
                return [];
            }),
        });

        await runIntegrationRadar(BASE_INPUT, deps);

        // Would fail against the specific bug it targets: swapping `!==` for `===` in
        // confirmed()'s tier check would gate exactly the wrong hit, and either
        // assertion below would catch it (the count would still be 1, but for the
        // wrong page, and the `toHaveBeenCalledWith` checks pin down which one).
        expect(isListPageSpy).toHaveBeenCalledTimes(1);
        expect(isListPageSpy).toHaveBeenCalledWith(searchHit, 'integrations');
        expect(isListPageSpy).not.toHaveBeenCalledWith(pathHit, 'integrations');
    });

    it('drops a search-tier hit that isListPage rejects, and never extracts names from it', async () => {
        const searchHit = hit('https://searchfound.com/marketing');
        const extractNamesSpy = vi.fn(async (page: PageHit): Promise<string[]> =>
            page.url.endsWith('/integrations') ? ['Existing Thing'] : ['Should Never Appear'],
        );

        const deps = baseDeps({
            extractCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'SearchFound', domain: 'searchfound.com' }]),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt', tier: 'path' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', tier: 'path' });
                }
                if (domain === 'searchfound.com') return resolved({ hit: searchHit, key: 'search-hit', tier: 'search' });
                return resolved({ hit: null, key: `${domain}-${kind}` });
            }),
            extractNames: extractNamesSpy,
            isListPage: vi.fn(async () => false), // the gate rejects it
        });

        // No directories and the one competitor is gated out -> no sources at all.
        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow('No source lists could be read.');
        expect(extractNamesSpy).not.toHaveBeenCalledWith(searchHit);
    });
});

describe('runIntegrationRadar — requirement 2: carry-forward on unresolved sources', () => {
    it('keeps a previously-known candidate in memory when its source fails to resolve this run', async () => {
        const okHit = hit('https://ok.com/integrations');
        const savePreviousSpy = vi.fn(async () => undefined);

        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            extractCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Ok', domain: 'ok.com' },
                { name: 'Flaky', domain: 'flaky.com' },
            ]),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                }
                if (domain === 'ok.com') return resolved({ hit: okHit, key: 'ok' });
                // flaky.com fails to resolve this run — the measured scenario (brightdata.com,
                // zyte.com): nothing changed on their end, the resolution attempt just came up empty.
                if (domain === 'flaky.com') return resolved({ hit: null, key: 'flaky' });
                return resolved({ hit: null, key: `${domain}-${kind}` });
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url.includes('mine.com')) return ['Existing Thing'];
                if (page.url === okHit.url) return ['Stable Candidate'];
                return [];
            }),
            loadPrevious: vi.fn(async () => ['flaky-only-candidate', 'stable-candidate']),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.fullCoverage).toBe(false); // flaky.com did not resolve

        // The naive bug this guards against: `savePrevious(companyDomain,
        // gaps.map((g) => g.slug), runDate)` — the brief's own original line — would
        // drop 'flaky-only-candidate' the instant flaky.com fails to resolve, even
        // though nothing proved that candidate actually went away.
        expect(savePreviousSpy).toHaveBeenCalledTimes(1);
        const [, savedSlugs] = savePreviousSpy.mock.calls[0];
        expect(savedSlugs).toContain('flaky-only-candidate');
        expect(savedSlugs).toContain('stable-candidate'); // still found this run

        // And the run's actual output correctly tags what it *did* find as SEEN, not NEW —
        // it was already in memory, flaky.com's outage is irrelevant to this candidate.
        expect(summary.rows.find((r) => r.slug === 'stable-candidate')?.status).toBe('SEEN');
    });
});

describe('runIntegrationRadar — critical fix: the display cap must not truncate memory', () => {
    it('carries every ranked candidate into memory even when maxRows truncates what is displayed', async () => {
        const rivalHit = hit('https://rival.com/integrations');
        // Five distinct candidates, all carried by the same single source, so all tie at
        // peerCount 1 / directoryCount 0 and computeGaps sorts them alphabetically by slug.
        const fiveNames = ['Candidate Alpha', 'Candidate Bravo', 'Candidate Charlie', 'Candidate Delta', 'Candidate Echo'];

        const savePreviousSpy = vi.fn(async () => undefined);
        const pushDataSpy = vi.fn(async () => undefined);

        const deps = baseDeps({
            maxRows: 2, // force truncation with a small, fast-to-verify pool
            savePrevious: savePreviousSpy,
            pushData: pushDataSpy,
            // Full coverage requires the fixed directory to resolve too, not just the
            // competitor — override the default "unresolved" fetchUrl explicitly.
            fetchUrl: vi.fn(async (url: string): Promise<Resolved> => resolved({ hit: hit(url), key: url })),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url === rivalHit.url) return fiveNames;
                // The own page and the directory both just echo what the company
                // already has, so both resolve (full coverage) without adding candidates.
                return ['Existing Thing'];
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.fullCoverage).toBe(true); // the competitor AND the directory both resolved fine

        // Display is capped: only the top 2 of 5 candidates are pushed and returned.
        expect(summary.rows).toHaveLength(2);
        expect(pushDataSpy).toHaveBeenCalledTimes(1);
        expect(pushDataSpy.mock.calls[0][0]).toHaveLength(2);

        // Memory must NOT be capped — this is the Critical finding from fix round 1's
        // review: `computeGaps(...).slice(0, MAX_ROWS)` running before the slugs used
        // for `savePrevious` are computed reproduces the exact "unresolved reads as
        // removed" bug requirement 2 exists to prevent, just triggered by rank jitter
        // around the cutoff instead of a source failing to resolve. If `.slice` ever
        // moves back above the memory computation, `savedSlugs` here drops from 5 to 2
        // and this assertion fails.
        expect(savePreviousSpy).toHaveBeenCalledTimes(1);
        const [, savedSlugs] = savePreviousSpy.mock.calls[0];
        expect(savedSlugs).toHaveLength(5);
    });
});
