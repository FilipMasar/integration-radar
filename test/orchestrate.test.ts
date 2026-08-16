import { describe, expect, it, vi } from 'vitest';
import type { Company, PageHit } from '../src/pure.js';
import { inputFingerprint } from '../src/pure.js';
import type { StoredMemory } from '../src/store.js';
import type { Resolved } from '../src/web.js';
// Type-only import: erased at compile time, so it needs no involvement from the
// `apify` mock below or from the dynamic `import()` used for the runtime value.
import type { Deps, Input } from '../src/orchestrate.js';

/**
 * Fix round 1, Important finding #2: `runIntegrationRadar`'s pure helpers
 * (`mergePreviousSlugs`) were well tested in `pure.test.ts`, but
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
// The mock object above, not the real logger: `log.warning` is the only observable for the
// truncation warning, which is a required behavior (a silently shortened competitor set
// reports gaps as if the whole set had been read), so one test asserts on it.
const { log } = await import('apify');

function hit(url: string, markdown = '# page'): PageHit {
    return { url, markdown };
}

function resolved(overrides: Partial<Resolved> = {}): Resolved {
    return { hit: hit('https://example.com/integrations'), fromCache: false, key: 'key', tier: 'path', ...overrides };
}

const BASE_INPUT: Input = {
    companyDomain: 'mine.com',
    maxCompetitors: 20,
};

/**
 * A minimal, fully-wired fake `Deps`: one competitor ("rival.com"), every call succeeds.
 * Each test overrides only the handful of fields it needs to exercise a specific behavior
 * — the rest keep the pipeline running end to end so the scenario under test isn't
 * drowned in unrelated setup.
 */
function baseDeps(overrides: Partial<Deps> = {}): Deps {
    const ownHit = hit('https://mine.com/integrations');
    const rivalHit = hit('https://rival.com/integrations');

    const base: Deps = {
        findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
            if (domain === 'mine.com') return resolved({ hit: ownHit, key: 'own' });
            if (domain === 'rival.com') return resolved({ hit: rivalHit, key: 'rival' });
            return resolved({ hit: null, key: domain });
        }),
        seedCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Rival', domain: 'rival.com' }]),
        extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
            if (page.url === ownHit.url) return ['Existing Thing'];
            if (page.url === rivalHit.url) return ['Candidate One'];
            return [];
        }),
        isListPage: vi.fn(async () => true),
        describeCandidates: vi.fn(async () => new Map()),
        readNames: vi.fn(async () => null),
        writeNames: vi.fn(async () => undefined),
        readSeed: vi.fn(async () => null),
        writeSeed: vi.fn(async () => undefined),
        readListPageVerdict: vi.fn(async () => null),
        writeListPageVerdict: vi.fn(async () => undefined),
        loadPrevious: vi.fn(async () => null),
        savePrevious: vi.fn(async () => undefined),
        pushData: vi.fn(async () => undefined),
        charge: vi.fn(async (event: { eventName: string; count: number }) => ({
            chargedCount: event.count,
            eventChargeLimitReached: false,
        })),
    };
    return { ...base, ...overrides };
}

/**
 * The fingerprint a run of `BASE_INPUT` against `baseDeps` produces. Stored memory carrying
 * anything else makes the run a baseline, so any test that wants a real NEW/SEEN diff must
 * seed this.
 *
 * `competitors` is spelled out even though `BASE_INPUT` supplies none: the fingerprint covers
 * the competitor set the run *effectively reads* (post self-exclusion, post `maxCompetitors`
 * cut), which for `baseDeps` is the one domain its seed names. A test that overrides the seed
 * with a different set needs its own fingerprint.
 */
const BASE_FINGERPRINT = inputFingerprint({ ...BASE_INPUT, competitors: ['rival.com'] });

/** Stored memory for `BASE_INPUT`, fingerprinted so the next run diffs rather than rebaselines. */
function storedMemory(slugs: string[], sources: string[]): StoredMemory {
    return { slugs, sources, fingerprint: BASE_FINGERPRINT };
}

/**
 * Stored memory for a run whose seed names something other than `baseDeps`' single
 * `rival.com` — the fingerprint has to name that run's own effective competitor set, or the
 * run rebaselines and the behavior under test never gets exercised.
 */
function storedMemoryFor(competitors: string[], slugs: string[], sources: string[]): StoredMemory {
    return { slugs, sources, fingerprint: inputFingerprint({ ...BASE_INPUT, competitors }) };
}

describe('runIntegrationRadar — requirement 1: gate search-tier hits, not path-tier hits', () => {
    it('calls isListPage for a search-tier hit and not for a path-tier hit', async () => {
        const ownHit = hit('https://mine.com/integrations');
        const pathHit = hit('https://rival.com/integrations'); // resolves via the path tier
        const searchHit = hit('https://searchfound.com/some-other-page'); // resolves via search

        const isListPageSpy = vi.fn(async () => true);

        const deps = baseDeps({
            isListPage: isListPageSpy,
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Rival', domain: 'rival.com' },
                { name: 'SearchFound', domain: 'searchfound.com' },
            ]),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') return resolved({ hit: ownHit, key: 'own', tier: 'path' });
                if (domain === 'rival.com') return resolved({ hit: pathHit, key: 'rival', tier: 'path' });
                if (domain === 'searchfound.com')
                    return resolved({ hit: searchHit, key: 'search-hit', tier: 'search' });
                return resolved({ hit: null, key: domain });
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
        expect(isListPageSpy).toHaveBeenCalledWith(searchHit);
        expect(isListPageSpy).not.toHaveBeenCalledWith(pathHit);
    });

    it('drops a search-tier hit that isListPage rejects, and never extracts names from it', async () => {
        const searchHit = hit('https://searchfound.com/marketing');
        const extractNamesSpy = vi.fn(async (page: PageHit): Promise<string[]> =>
            page.url.endsWith('/integrations') ? ['Existing Thing'] : ['Should Never Appear'],
        );

        const deps = baseDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'SearchFound', domain: 'searchfound.com' },
            ]),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', tier: 'path' });
                }
                if (domain === 'searchfound.com')
                    return resolved({ hit: searchHit, key: 'search-hit', tier: 'search' });
                return resolved({ hit: null, key: domain });
            }),
            extractNames: extractNamesSpy,
            isListPage: vi.fn(async () => false), // the gate rejects it
        });

        // The one competitor is gated out, so nothing is left to compare against.
        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'No competitor integrations pages could be read.',
        );
        expect(extractNamesSpy).not.toHaveBeenCalledWith(searchHit);
    });
});

describe('runIntegrationRadar — requirement 2: carry-forward on unresolved sources', () => {
    it('keeps a previously-known candidate in memory when its source fails to resolve this run', async () => {
        const okHit = hit('https://ok.com/integrations');
        const savePreviousSpy = vi.fn(async () => undefined);

        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Ok', domain: 'ok.com' },
                { name: 'Flaky', domain: 'flaky.com' },
            ]),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                }
                if (domain === 'ok.com') return resolved({ hit: okHit, key: 'ok' });
                // flaky.com fails to resolve this run — the measured scenario (brightdata.com,
                // zyte.com): nothing changed on their end, the resolution attempt just came up empty.
                if (domain === 'flaky.com') return resolved({ hit: null, key: 'flaky' });
                return resolved({ hit: null, key: domain });
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url.includes('mine.com')) return ['Existing Thing'];
                if (page.url === okHit.url) return ['Stable Candidate'];
                return [];
            }),
            // Memory rests on both competitors; only ok.com answered this run. Fingerprinted
            // against this run's own two-competitor set, so the run is a real diff — a
            // mismatch would rebaseline it and never exercise the carry-forward rule.
            loadPrevious: vi.fn(async () =>
                storedMemoryFor(
                    ['ok.com', 'flaky.com'],
                    ['flaky-only-candidate', 'stable-candidate'],
                    ['ok.com', 'flaky.com'],
                ),
            ),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        // flaky.com did not resolve, so memory is unioned, not superseded.
        expect(summary.memoryReplaced).toBe(false);

        // The naive bug this guards against: `savePrevious(companyDomain,
        // gaps.map((g) => g.slug), runDate)` — the brief's own original line — would
        // drop 'flaky-only-candidate' the instant flaky.com fails to resolve, even
        // though nothing proved that candidate actually went away.
        expect(savePreviousSpy).toHaveBeenCalledTimes(1);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toContain('flaky-only-candidate');
        expect(saved.slugs).toContain('stable-candidate'); // still found this run
        // The evidence base keeps flaky.com, so the next run cannot "cover" memory
        // without reading it either.
        expect(saved.sources).toContain('flaky.com');

        // And the run's actual output correctly tags what it *did* find as SEEN, not NEW —
        // it was already in memory, flaky.com's outage is irrelevant to this candidate.
        expect(summary.rows.find((r) => r.slug === 'stable-candidate')?.status).toBe('SEEN');
    });
});

/**
 * A competitor that *throws* and a competitor that resolves to nothing are the same
 * real-world event — that source did not answer this run — but they reach the pipeline by
 * different routes. `findIntegrations` and `extractNames` swallow their own failures, so the
 * unguarded surface is the store: `readMiss`, `readCache`, `readNames`, `readListPageVerdict`.
 * Without the try/catch in the `mapLimit` callback a single key-value API error rejects
 * `Promise.all` and aborts the whole run *before* `pushData`, so the user pays for the seed,
 * their own page and every competitor already read, and receives nothing.
 *
 * Both tests below therefore assert more than "it did not throw": they pin that the failure
 * lands in the carry-forward path built for an unresolved source, which is the behavior that
 * makes swallowing it correct rather than merely convenient.
 */
describe('runIntegrationRadar — one competitor failing must not fail the run', () => {
    /** Memory resting on both competitors, so the carry-forward rule is actually exercised. */
    const twoSourceMemory = () =>
        storedMemoryFor(['ok.com', 'flaky.com'], ['flaky-only-candidate', 'stable-candidate'], ['ok.com', 'flaky.com']);

    const twoCompetitors = vi.fn(async (): Promise<Company[]> => [
        { name: 'Ok', domain: 'ok.com' },
        { name: 'Flaky', domain: 'flaky.com' },
    ]);

    it('skips a competitor whose page lookup throws, and still reports the others', async () => {
        vi.mocked(log.warning).mockClear();
        const okHit = hit('https://ok.com/integrations');
        const savePreviousSpy = vi.fn(async () => undefined);
        const pushDataSpy = vi.fn(async () => undefined);

        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            pushData: pushDataSpy,
            seedCompetitors: twoCompetitors,
            loadPrevious: vi.fn(async () => twoSourceMemory()),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                if (domain === 'ok.com') return resolved({ hit: okHit, key: 'ok' });
                // What a 500 from the key-value store looks like from here: readMiss/readCache
                // are the first thing findIntegrations does, and neither is guarded.
                if (domain === 'flaky.com') throw new Error('key-value store request failed with status 500');
                return resolved({ hit: null, key: domain });
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url.includes('mine.com')) return ['Existing Thing'];
                if (page.url === okHit.url) return ['Stable Candidate'];
                return [];
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        // The surviving competitor's work is delivered — the point of not aborting.
        expect(pushDataSpy).toHaveBeenCalledTimes(1);
        expect(summary.rows.map((r) => r.slug)).toContain('stable-candidate');

        // And the thrower is treated as an unresolved source, not as a source that answered
        // "nothing": memory is unioned rather than superseded, so the candidate only
        // flaky.com carries survives and cannot come back as NEW next run.
        expect(summary.memoryReplaced).toBe(false);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toContain('flaky-only-candidate');

        expect(log.warning).toHaveBeenCalledWith('Competitor failed — skipping it, not the run', {
            domain: 'flaky.com',
            error: 'key-value store request failed with status 500',
        });
    });

    it('skips a competitor that throws after its page resolved, when the names read fails', async () => {
        const okHit = hit('https://ok.com/integrations');
        const flakyHit = hit('https://flaky.com/integrations');
        const savePreviousSpy = vi.fn(async () => undefined);

        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            seedCompetitors: twoCompetitors,
            loadPrevious: vi.fn(async () => twoSourceMemory()),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                if (domain === 'ok.com') return resolved({ hit: okHit, key: 'ok' });
                if (domain === 'flaky.com') return resolved({ hit: flakyHit, key: 'flaky' });
                return resolved({ hit: null, key: domain });
            }),
            // Throws only for flaky.com's record, and only after its page resolved cleanly.
            // A try/catch wrapping just the findIntegrations call would let this one through.
            readNames: vi.fn(async (key: string) => {
                if (key === 'flaky') throw new Error('key-value store request failed with status 503');
                return null;
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url.includes('mine.com')) return ['Existing Thing'];
                if (page.url === okHit.url) return ['Stable Candidate'];
                return ['Never Reached'];
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows.map((r) => r.slug)).toContain('stable-candidate');
        expect(summary.rows.map((r) => r.slug)).not.toContain('never-reached');
        expect(summary.memoryReplaced).toBe(false);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toContain('flaky-only-candidate');
    });
});

describe('runIntegrationRadar — critical fix: the display cap must not truncate memory', () => {
    it('carries every ranked candidate into memory even when maxRows truncates what is displayed', async () => {
        const rivalHit = hit('https://rival.com/integrations');
        // Five distinct candidates, all carried by the same single competitor, so all tie
        // at competitorCount 1 and rankCandidates sorts them alphabetically by slug.
        const fiveNames = [
            'Candidate Alpha',
            'Candidate Bravo',
            'Candidate Charlie',
            'Candidate Delta',
            'Candidate Echo',
        ];

        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);
        const pushDataSpy = vi.fn(async () => undefined);

        const deps = baseDeps({
            maxRows: 2, // force truncation with a small, fast-to-verify pool
            savePrevious: savePreviousSpy,
            pushData: pushDataSpy,
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url === rivalHit.url) return fiveNames;
                // The own page just echoes what the company already has, so it resolves
                // without adding candidates.
                return ['Existing Thing'];
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        // Display is capped: only the top 2 of 5 candidates are pushed and returned.
        expect(summary.rows).toHaveLength(2);
        expect(pushDataSpy).toHaveBeenCalledTimes(1);
        expect(pushDataSpy.mock.calls[0][0]).toHaveLength(2);

        // Memory must NOT be capped — this is the Critical finding from fix round 1's
        // review: `rankCandidates(...).slice(0, MAX_ROWS)` running before the slugs used
        // for `savePrevious` are computed reproduces the exact "unresolved reads as
        // removed" bug requirement 2 exists to prevent, just triggered by rank jitter
        // around the cutoff instead of a source failing to resolve. If `.slice` ever
        // moves back above the memory computation, `saved.slugs` here drops from 5 to 2
        // and this assertion fails.
        expect(savePreviousSpy).toHaveBeenCalledTimes(1);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toHaveLength(5);
        // `totalRanked` reports the untruncated pool, so a reader can see that the
        // displayed rows are a slice rather than the whole answer.
        expect(summary.totalRanked).toBe(5);
    });

    it('reports a candidate carried by a single competitor — there is no evidence threshold', async () => {
        // Two competitors: one carries both candidates, the other only 'shared'. Both are
        // reported; 'lonely' resting on one page is a real signal, not noise to suppress.
        const deps = baseDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'A', domain: 'a.com' },
                { name: 'B', domain: 'b.com' },
            ]),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                }
                return resolved({ hit: hit(`https://${domain}/integrations`), key: domain });
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url.includes('mine.com')) return ['Existing Thing'];
                if (page.url.includes('a.com')) return ['Shared', 'Lonely'];
                return ['Shared'];
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows.map((r) => r.slug)).toEqual(['shared', 'lonely']);
        expect(summary.rows.map((r) => r.competitorCount)).toEqual([2, 1]);
    });
});

describe('runIntegrationRadar — memory describes the conditions it was gathered under', () => {
    it('reports a baseline instead of a diff when the inputs changed since the stored run', async () => {
        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);
        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            // Memory gathered under a different maxCompetitors — a tuning the README
            // actively recommends. Diffing against it would report every candidate the
            // old threshold excluded as NEW.
            loadPrevious: vi.fn(async () => ({
                slugs: ['something-else'],
                sources: ['rival.com'],
                fingerprint: inputFingerprint({ ...BASE_INPUT, maxCompetitors: 3 }),
            })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.isBaseline).toBe(true);
        expect(summary.rows.every((r) => r.status === 'BASELINE')).toBe(true);
        expect(summary.rows.some((r) => r.status === 'NEW')).toBe(false);

        // Memory is still never lost across the change — the run after this one must not
        // see 'something-else' come back as NEW either.
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toContain('something-else');
        expect(saved.fingerprint).toBe(BASE_FINGERPRINT);
    });

    it('treats a pre-fingerprint stored record as a baseline rather than diffing blind', async () => {
        const deps = baseDeps({
            loadPrevious: vi.fn(async () => ({ slugs: ['candidate-one'], sources: [], fingerprint: null })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.isBaseline).toBe(true);
    });

    it('diffs normally when the fingerprint matches', async () => {
        const deps = baseDeps({ loadPrevious: vi.fn(async () => storedMemory(['candidate-one'], ['rival.com'])) });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.isBaseline).toBe(false);
        expect(summary.rows.find((r) => r.slug === 'candidate-one')?.status).toBe('SEEN');
    });

    it('does not replace memory when a competitor silently vanished from the competitor set', async () => {
        // The Critical hole the old coverage-flag gate could not see: the competitor set
        // holds one competitor fewer than the run memory rests on, so there is no
        // unresolved entry at all — the list is simply shorter, coverage reads "complete",
        // and memory would be replaced, erasing everything the departed competitor carried.
        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);
        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('rival.com') ? ['Candidate One'] : ['Existing Thing'],
            ),
            // `departed.com` is the ONLY source in the basis this run does not cover, so the
            // assertion below can only be satisfied by the superset test noticing it.
            loadPrevious: vi.fn(async () =>
                storedMemory(['candidate-one', 'gone-with-departed'], ['rival.com', 'departed.com']),
            ),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        // Everything this run attempted resolved — the old gate would have said "replace".
        expect(summary.memoryReplaced).toBe(false);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toContain('gone-with-departed');
    });

    it('replaces memory once a run covers every source memory rests on', async () => {
        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);
        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('rival.com') ? ['Candidate One'] : ['Existing Thing'],
            ),
            // Memory rests on `rival.com` alone, which this run resolves — so the basis is
            // covered and the replace branch fires.
            loadPrevious: vi.fn(async () => storedMemory(['candidate-one', 'really-gone'], ['rival.com'])),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.memoryReplaced).toBe(true);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).not.toContain('really-gone'); // the removal property, actually true
    });
});

describe('runIntegrationRadar — charging', () => {
    /** Records the order of the side effects that spend the user's money. */
    function orderedDeps(overrides: Partial<Deps> = {}): { deps: Deps; calls: string[] } {
        const calls: string[] = [];
        const deps = baseDeps({
            pushData: vi.fn(async () => {
                calls.push('pushData');
            }),
            savePrevious: vi.fn(async () => {
                calls.push('savePrevious');
            }),
            charge: vi.fn(async (event: { eventName: string; count: number }) => {
                calls.push(`charge:${event.eventName}:${event.count}`);
                return { chargedCount: event.count, eventChargeLimitReached: false };
            }),
            ...overrides,
        });
        return { deps, calls };
    }

    it('charges only after the dataset has been pushed', async () => {
        // A charge before the push means a migration between the two leaves the user
        // paying for a run that produced nothing.
        const { deps, calls } = orderedDeps();
        await runIntegrationRadar(BASE_INPUT, deps);

        expect(calls[0]).toBe('pushData');
        expect(calls.filter((c) => c.startsWith('charge:'))).toHaveLength(2);
        expect(calls.indexOf('pushData')).toBeLessThan(calls.findIndex((c) => c.startsWith('charge:')));
    });

    it('charges the two advertised event names, with the counts they advertise', async () => {
        // Pins the strings against `.actor/pay_per_event.json`, which nothing else reads:
        // a typo in either eventName is otherwise invisible to build, test and lint.
        // Cold run: the own integrations page and one competitor are fetched fresh; the
        // placeholder directory does not resolve.
        const { deps, calls } = orderedDeps();
        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.freshSources).toBe(2);
        expect(calls).toContain('charge:source-analyzed:2');
        expect(calls).toContain(`charge:candidate-found:${summary.rows.length}`);
        expect(summary.chargedEvents).toBe(2 + summary.rows.length);
    });

    it('never charges source-analyzed for a page served from cache', async () => {
        // The guard is `if (!resolved.fromCache)`. Deleting it bills the user again for
        // every page on every warm run — the README promises the opposite.
        const { deps, calls } = orderedDeps({
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', fromCache: true });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival', fromCache: true });
                }
                return resolved({ hit: null, key: domain });
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.freshSources).toBe(0);
        expect(calls.some((c) => c.startsWith('charge:source-analyzed'))).toBe(false);
        expect(calls).toContain(`charge:candidate-found:${summary.rows.length}`);
    });

    it('never charges a miss that came back from the miss cache', async () => {
        // `fromCache: true, hit: null` — a known miss. It resolved nothing, so there is
        // nothing to charge for, and the `hit` check must run before the cache check.
        const { deps, calls } = orderedDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Rival', domain: 'rival.com' },
                { name: 'Missed', domain: 'missed.com' },
            ]),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival' });
                }
                return resolved({ hit: null, fromCache: true, key: 'missed' });
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.freshSources).toBe(2); // own + rival, not the cached miss
        expect(calls).toContain('charge:source-analyzed:2');
    });

    it('reports an under-charge instead of swallowing it', async () => {
        // Apify caps a batched charge at the user's ACTOR_MAX_TOTAL_CHARGE_USD and
        // returns the truth in `chargedCount`. Discarding the ChargeResult — the old
        // `.then(() => undefined)` — makes a budget-capped run silently under-bill.
        const deps = baseDeps({
            charge: vi.fn(async () => ({ chargedCount: 1, eventChargeLimitReached: true })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.chargingState).toBe('capped');
        expect(summary.chargedEvents).toBe(2); // one per capped call, not the counts requested
    });

    it('reports a partial charge as capped even when the platform did not set the limit flag', async () => {
        // A partial charge is a cap by construction: something was billed and it was less
        // than requested. The flag must not be the only thing that can produce 'capped'.
        const deps = baseDeps({
            charge: vi.fn(async () => ({ chargedCount: 1, eventChargeLimitReached: false })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.chargingState).toBe('capped');
        expect(summary.chargedEvents).toBe(2);
    });

    it('reports a fully refused charge as capped when the platform set the limit flag', async () => {
        // Zero charged is only "inactive" when the platform also reports no limit. With
        // the flag set it is a real budget event and must not be reported as a non-PPE run.
        const deps = baseDeps({
            charge: vi.fn(async () => ({ chargedCount: 0, eventChargeLimitReached: true })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.chargingState).toBe('capped');
        expect(summary.chargedEvents).toBe(0);
    });

    it('reports a non-pay-per-event run as inactive, not as a budget cap', async () => {
        // The SDK no-ops Actor.charge on a non-PPE run and on a local run without
        // ACTOR_TEST_PAY_PER_EVENT, returning chargedCount 0 with no limit reached.
        // Reading that as "the user hit their max-charge limit" misattributes the cause
        // and contradicts the run's own summary, which correctly reports no cap. Both
        // live verification runs emitted exactly that contradiction.
        const deps = baseDeps({
            charge: vi.fn(async () => ({ chargedCount: 0, eventChargeLimitReached: false })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.chargingState).toBe('inactive');
        expect(summary.chargedEvents).toBe(0);
    });

    it('reports no charging state at all when nothing was chargeable', async () => {
        const deps = baseDeps({
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', fromCache: true });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival', fromCache: true });
                }
                return resolved({ hit: null, key: domain });
            }),
            extractNames: vi.fn(async (): Promise<string[]> => ['Existing Thing']),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.chargingState).toBe('none');
    });

    it('does not call charge at all when there is nothing to charge for', async () => {
        // Every source cached and no candidates found: a zero-count charge is still a
        // billing API call and must not be made.
        const deps = baseDeps({
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', fromCache: true });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival', fromCache: true });
                }
                return resolved({ hit: null, key: domain });
            }),
            // The competitor lists exactly what the company already has -> no candidates.
            extractNames: vi.fn(async (): Promise<string[]> => ['Existing Thing']),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows).toHaveLength(0);
        expect(deps.charge).not.toHaveBeenCalled();
    });
});

describe('runIntegrationRadar — cache reuse at the orchestration layer', () => {
    it('reuses cached names instead of paying for the extraction again', async () => {
        // `readNames` was stubbed to null in every test, so this branch never ran:
        // deleting the readNames call — re-paying the single biggest cost line on every
        // run — passed the whole suite.
        const extractNamesSpy = vi.fn(async (page: PageHit): Promise<string[]> =>
            page.url.includes('mine.com') ? ['Existing Thing'] : ['Freshly Extracted'],
        );
        const deps = baseDeps({
            extractNames: extractNamesSpy,
            readNames: vi.fn(async (key: string) => (key === 'rival' ? ['Cached Candidate'] : null)),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows.map((r) => r.slug)).toEqual(['cached-candidate']);
        expect(extractNamesSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://rival.com/integrations' }),
        );
        expect(deps.writeNames).not.toHaveBeenCalledWith('rival', expect.anything());
    });

    it('reads the competitor set the cached seed holds, not one the LLM would derive', async () => {
        // The read side of the seed cache, asserted by *content* rather than only by "the
        // LLM was not called" (which the step-1 block does): a cached seed that was fetched
        // and then ignored would satisfy the spy assertion and still re-roll the source set.
        const deps = baseDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Wrong', domain: 'wrong.com' }]),
            readSeed: vi.fn(async () => [{ name: 'Rival', domain: 'rival.com' }]),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows[0].carriedBy).toEqual(['rival.com']);
    });

    it('caches freshly extracted names against the page record they came from', async () => {
        // Asserted positively, not just "not called on a cache hit": deleting the
        // writeNames call entirely leaves the read side working and permanently defeats
        // the names cache — the single biggest cost line in a run — with no test failing.
        const deps = baseDeps();
        await runIntegrationRadar(BASE_INPUT, deps);

        expect(deps.writeNames).toHaveBeenCalledWith('own', ['Existing Thing']);
        expect(deps.writeNames).toHaveBeenCalledWith('rival', ['Candidate One']);
    });

    it('does not cache an empty extraction, which would read back as a page with no names', async () => {
        const deps = baseDeps({
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('mine.com') ? ['Existing Thing'] : [],
            ),
        });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'No competitor integrations pages could be read.',
        );
        expect(deps.writeNames).not.toHaveBeenCalledWith('rival', expect.anything());
    });

    it('honours a cached rejection without calling the LLM gate again', async () => {
        // The correctness fix of round 1: re-rolling an isListPage verdict on unchanged
        // content can flip rejected->accepted and inject a NEW sourced from nothing but
        // model nondeterminism. `readListPageVerdict` was stubbed null everywhere, so
        // only the "never gated" side of `cachedVerdict ?? await isListPage(...)` ran.
        const isListPageSpy = vi.fn(async () => true);
        const deps = baseDeps({
            isListPage: isListPageSpy,
            readListPageVerdict: vi.fn(async (key: string) => (key === 'rival' ? false : null)),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', tier: 'path' });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/marketing'), key: 'rival', tier: 'search' });
                }
                return resolved({ hit: null, key: domain });
            }),
        });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'No competitor integrations pages could be read.',
        );
        expect(isListPageSpy).not.toHaveBeenCalled();
        expect(deps.writeListPageVerdict).not.toHaveBeenCalled();
    });

    it('honours a cached acceptance without calling the LLM gate again', async () => {
        const isListPageSpy = vi.fn(async () => false);
        const deps = baseDeps({
            isListPage: isListPageSpy,
            readListPageVerdict: vi.fn(async (key: string) => (key === 'rival' ? true : null)),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', tier: 'path' });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival', tier: 'search' });
                }
                return resolved({ hit: null, key: domain });
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(isListPageSpy).not.toHaveBeenCalled();
        expect(summary.rows.map((r) => r.slug)).toEqual(['candidate-one']);
    });
});

describe('runIntegrationRadar — weakEvidence', () => {
    it('flags a candidate whose only support resolved via search, and not one that resolved via a path guess', async () => {
        const deps = baseDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Pathy', domain: 'pathy.com' },
                { name: 'Searchy', domain: 'searchy.com' },
            ]),
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> => {
                if (domain === 'mine.com') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', tier: 'path' });
                }
                if (domain === 'pathy.com') {
                    return resolved({ hit: hit('https://pathy.com/integrations'), key: 'pathy', tier: 'path' });
                }
                return resolved({ hit: hit('https://searchy.com/found'), key: 'searchy', tier: 'search' });
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url.includes('mine.com')) return ['Existing Thing'];
                if (page.url.includes('pathy.com')) return ['Path Only'];
                return ['Search Only'];
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        // Inverting the comparison to `=== 'path'`, or never populating tierBySource,
        // flips both of these.
        expect(summary.rows.find((r) => r.slug === 'search-only')?.weakEvidence).toBe(true);
        expect(summary.rows.find((r) => r.slug === 'path-only')?.weakEvidence).toBe(false);
    });
});

describe('runIntegrationRadar — step 1: the competitor seed', () => {
    /** Deps whose competitor pages all resolve, so a cap can be observed by call count. */
    function resolvingDeps(overrides: Partial<Deps> = {}): Deps {
        return baseDeps({
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> =>
                resolved({ hit: hit(`https://${domain}/integrations`), key: domain }),
            ),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('mine.com') ? ['Existing Thing'] : [`From ${new URL(page.url).hostname}`],
            ),
            ...overrides,
        });
    }

    it('uses a cached seed without calling the LLM', async () => {
        const seedSpy = vi.fn(async (): Promise<Company[]> => [{ name: 'Rival', domain: 'rival.com' }]);
        const deps = baseDeps({
            readSeed: vi.fn(async () => [{ name: 'Rival', domain: 'rival.com' }]),
            seedCompetitors: seedSpy,
        });

        await runIntegrationRadar(BASE_INPUT, deps);

        expect(seedSpy).not.toHaveBeenCalled();
        // A cache hit must not be written back either — `writeSeed` on a hit is harmless
        // today but would become a re-roll the moment the record carried a timestamp.
        expect(deps.writeSeed).not.toHaveBeenCalled();
    });

    it('derives and stores a seed on a miss', async () => {
        const deps = baseDeps();

        await runIntegrationRadar(BASE_INPUT, deps);

        expect(deps.seedCompetitors).toHaveBeenCalledWith('mine.com', 20);
        expect(deps.writeSeed).toHaveBeenCalledWith('mine.com', 20, [{ name: 'Rival', domain: 'rival.com' }]);
    });

    it('fails with a pointer to the override when the seed is empty', async () => {
        const deps = baseDeps({ seedCompetitors: vi.fn(async () => []) });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'Could not determine competitors for mine.com. Pass them explicitly via the "competitors" input.',
        );
        // Never cache an empty derivation: `[]` written here would read back as a hit and
        // pin the domain to "no competitors" permanently, since the seed never expires.
        expect(deps.writeSeed).not.toHaveBeenCalled();
    });

    it('uses an explicit competitors input and never touches the seed', async () => {
        const deps = baseDeps();

        await runIntegrationRadar({ ...BASE_INPUT, competitors: ['rival.com'] }, deps);

        expect(deps.seedCompetitors).not.toHaveBeenCalled();
        expect(deps.readSeed).not.toHaveBeenCalled();
        expect(deps.writeSeed).not.toHaveBeenCalled();
        expect(deps.findIntegrations).toHaveBeenCalledWith('rival.com');
    });

    it('normalizes a supplied competitor entry that is not a bare domain', async () => {
        const deps = resolvingDeps();

        // Deliberately a domain the default seed does not contain, so this cannot pass by
        // accidentally falling through to the seed.
        await runIntegrationRadar({ ...BASE_INPUT, competitors: ['https://www.PEER.com/pricing'] }, deps);

        // Not passed through raw, and not rejected either: `sourceName` collapses it to the
        // one spelling the rest of the pipeline tracks a source under.
        expect(deps.findIntegrations).toHaveBeenCalledWith('peer.com');
    });

    it('drops only the unusable entries from a partly-valid supplied list', async () => {
        vi.mocked(log.warning).mockClear();
        const deps = baseDeps();

        await runIntegrationRadar({ ...BASE_INPUT, competitors: ['rival.com', 'not a domain'] }, deps);

        // One typo in a pasted list must neither kill the run nor pass silently.
        expect(deps.findIntegrations).toHaveBeenCalledWith('rival.com');
        expect(log.warning).toHaveBeenCalledWith('Ignored competitor entries that are not bare domains', {
            rejected: ['not a domain'],
        });
    });

    it('rejects an explicit competitors input with no usable domain', async () => {
        await expect(runIntegrationRadar({ ...BASE_INPUT, competitors: ['not a domain'] }, baseDeps())).rejects.toThrow(
            'No usable competitor domains in the "competitors" input',
        );
    });

    it('rejects a competitors input that is not an array', async () => {
        // The schema's `type: array` binds the Console form, not an API caller. A bare
        // string has a `length`, so it passes the `supplied.length > 0` test and then dies
        // inside `normalizeCompetitors` with `input.competitors.map is not a function` —
        // an error naming neither the input nor the mistake.
        const deps = baseDeps();

        await expect(
            // Cast because the whole scenario is a caller who ignored the type.
            runIntegrationRadar({ ...BASE_INPUT, competitors: 'rival.com' as unknown as string[] }, deps),
        ).rejects.toThrow('"competitors" must be an array of bare domains');
        // Fatal before anything is fetched or billed, same as the maxCompetitors guard.
        expect(deps.findIntegrations).not.toHaveBeenCalled();
        expect(deps.charge).not.toHaveBeenCalled();
    });

    it('excludes the analyzed company from its own competitor set', async () => {
        const deps = baseDeps({
            // Domains as `seedCompetitors` really returns them: every producer of a
            // `Company[]` runs `normalizeCompetitors`, so a `www.` prefix cannot reach here.
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Mine', domain: 'mine.com' },
                { name: 'Rival', domain: 'rival.com' },
            ]),
        });

        await runIntegrationRadar(BASE_INPUT, deps);

        // Called for the own integrations page, and for rival.com — but never for
        // mine.com as a competitor, which would let the company's own page carry a
        // candidate toward its own competitor count.
        expect(deps.findIntegrations).toHaveBeenCalledTimes(2);
        expect(deps.findIntegrations).toHaveBeenCalledWith('mine.com');
        expect(deps.findIntegrations).toHaveBeenCalledWith('rival.com');
    });

    it('fails when the company itself was the only competitor named', async () => {
        const deps = baseDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Mine', domain: 'mine.com' }]),
        });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'No competitors left for mine.com after excluding the company itself.',
        );
    });

    it('caps a seeded competitor set at maxCompetitors, and says so', async () => {
        vi.mocked(log.warning).mockClear();
        const deps = resolvingDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'A', domain: 'a.com' },
                { name: 'B', domain: 'b.com' },
                { name: 'C', domain: 'c.com' },
            ]),
        });

        await runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: 2 }, deps);

        // The own page plus exactly two competitors, and the third is the one cut.
        expect(deps.findIntegrations).toHaveBeenCalledTimes(3);
        expect(deps.findIntegrations).not.toHaveBeenCalledWith('c.com');
        // Bounded cost, but never silently: a run that quietly ignored a third of the
        // competitor set would report gaps as if it had read all of it.
        expect(log.warning).toHaveBeenCalledWith('Competitor list truncated', { found: 3, maxCompetitors: 2 });
    });

    it('refuses a maxCompetitors below 1 instead of capping the set to nothing', async () => {
        // `minimum: 1` in the input schema binds the Console form, not an API caller, and
        // `0 ?? 20` is `0`, so the default does not rescue it either. Left to reach the cut,
        // `slice(0, 0)` empties a perfectly good competitor set *after* the fatal checks
        // have passed — the run then reads and charges for the company's own page and every
        // directory before producing a directory-only report or dying somewhere unrelated.
        const deps = baseDeps();

        await expect(runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: 0 }, deps)).rejects.toThrow(
            '"maxCompetitors" must be an integer of at least 1, got 0.',
        );
        // Fatal before anything is fetched, so nothing is billed for a run that cannot work.
        expect(deps.findIntegrations).not.toHaveBeenCalled();
        expect(deps.charge).not.toHaveBeenCalled();
    });

    it('refuses a maxCompetitors that is not a whole number', async () => {
        // A bare `< 1` test would let `NaN` through — every comparison against it is false —
        // and `slice(0, NaN)` empties the set exactly like `slice(0, 0)` does.
        await expect(runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: Number.NaN }, baseDeps())).rejects.toThrow(
            '"maxCompetitors" must be an integer of at least 1',
        );
    });

    it('keeps the model ordering when it cuts, rather than the alphabetical one', async () => {
        // The old code sorted alphabetically before slicing, to make the cut stable across
        // a re-derived set. The seed is derived once and cached permanently, so the cut is
        // stable anyway — and keeping the model's order means the survivors are the most
        // direct competitors rather than the alphabetically first ones.
        const deps = resolvingDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Zulu', domain: 'zulu.com' },
                { name: 'Alpha', domain: 'alpha.com' },
            ]),
        });

        await runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: 1 }, deps);

        expect(deps.findIntegrations).toHaveBeenCalledWith('zulu.com');
        expect(deps.findIntegrations).not.toHaveBeenCalledWith('alpha.com');
    });

    it('caps a supplied competitor list at maxCompetitors too, and says so', async () => {
        vi.mocked(log.warning).mockClear();
        const deps = resolvingDeps();

        await runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: 2, competitors: ['a.com', 'b.com', 'c.com'] }, deps);

        // Same rule for an explicit list as for a seeded one: the own page plus two.
        expect(deps.findIntegrations).toHaveBeenCalledTimes(3);
        expect(deps.findIntegrations).not.toHaveBeenCalledWith('c.com');
        expect(log.warning).toHaveBeenCalledWith('Competitor list truncated', { found: 3, maxCompetitors: 2 });
    });

    it('does not charge source-analyzed for the seed', async () => {
        const deps = baseDeps();

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        // Only the own integrations page and rival.com resolved fresh. The alternatives
        // page this replaced was a third charged source.
        expect(summary.freshSources).toBe(2);
    });
});

describe('runIntegrationRadar — the fingerprint covers the effective competitor set', () => {
    /** Every competitor domain resolves, each page carrying one candidate named after it. */
    function resolvingDeps(overrides: Partial<Deps> = {}): Deps {
        return baseDeps({
            findIntegrations: vi.fn(async (domain: string): Promise<Resolved> =>
                resolved({ hit: hit(`https://${domain}/integrations`), key: domain }),
            ),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('mine.com') ? ['Existing Thing'] : [`From ${new URL(page.url).hostname}`],
            ),
            ...overrides,
        });
    }

    /** One run against a given stored memory, returning what it stored for the next one. */
    async function run(
        input: Input,
        previous: StoredMemory | null,
        overrides: Partial<Deps> = {},
    ): Promise<{ summary: Awaited<ReturnType<typeof runIntegrationRadar>>; stored: StoredMemory }> {
        const saved: StoredMemory[] = [];
        const deps = resolvingDeps({
            loadPrevious: vi.fn(async () => previous),
            savePrevious: vi.fn(async (_domain: string, memory: StoredMemory) => {
                saved.push(memory);
            }),
            ...overrides,
        });
        const summary = await runIntegrationRadar(input, deps);
        return { summary, stored: saved[0] };
    }

    it('declares a baseline when reordering an over-long supplied list changes which competitors are read', async () => {
        const first: Input = { ...BASE_INPUT, maxCompetitors: 2, competitors: ['a.com', 'b.com', 'c.com'] };
        const { stored } = await run(first, null);

        // The same three domains in a different order — but the cut keeps the user's first
        // two, so this run reads c.com and b.com where the last one read a.com and b.com.
        // Fingerprinting the *supplied* list sorts and dedupes it ("reordering the same list
        // is not a different question"), which is true only while the list fits under
        // `maxCompetitors`. Past the cut, reordering changes which page is opened, and every
        // candidate carried only by c.com would be reported NEW — "your competitor just
        // added this" when nothing happened but a reordered input.
        const reordered: Input = { ...first, competitors: ['c.com', 'b.com', 'a.com'] };
        const { summary } = await run(reordered, stored);

        expect(summary.isBaseline).toBe(true);
        expect(summary.rows.some((r) => r.status === 'NEW')).toBe(false);
        expect(summary.rows.find((r) => r.slug === 'from-c-com')?.status).toBe('BASELINE');
    });

    it('still diffs when the same over-long list is submitted in the same order', async () => {
        // The control the test above needs: fingerprinting the effective set must not turn
        // every run into a baseline. Same input twice, same two competitors read, so the
        // second run is a real diff.
        const input: Input = { ...BASE_INPUT, maxCompetitors: 2, competitors: ['a.com', 'b.com', 'c.com'] };
        const { stored } = await run(input, null);
        const { summary } = await run(input, stored);

        expect(summary.isBaseline).toBe(false);
        expect(summary.rows.find((r) => r.slug === 'from-a-com')?.status).toBe('SEEN');
    });

    it('keeps the fingerprint stable across runs on the seeded path, so a cached seed never rebaselines', async () => {
        // The consequence of fingerprinting the effective set rather than the input: on the
        // seeded path that set is the model's domains, not anything the user typed. It has to
        // be identical run to run — the seed is cached permanently and the cut is re-applied
        // identically on every read — or every run would declare BASELINE forever and
        // NEW/SEEN would never work at all, which is worse than the bug being fixed.
        const seeded: Company[] = [
            { name: 'A', domain: 'a.com' },
            { name: 'B', domain: 'b.com' },
            { name: 'C', domain: 'c.com' },
        ];
        // A seed record that survives between the two runs, like the real named store.
        let seedRecord: Company[] | null = null;
        const seedSpy = vi.fn(async () => seeded);
        const persistentSeed: Partial<Deps> = {
            readSeed: vi.fn(async () => seedRecord),
            writeSeed: vi.fn(async (_domain: string, _max: number, competitors: Company[]) => {
                seedRecord = competitors;
            }),
            seedCompetitors: seedSpy,
        };

        // maxCompetitors below the seed length, so the cut is live on both runs.
        const input: Input = { ...BASE_INPUT, maxCompetitors: 2 };
        const first = await run(input, null, persistentSeed);
        const second = await run(input, first.stored, persistentSeed);

        expect(seedSpy).toHaveBeenCalledTimes(1); // run 2 read the cache
        expect(second.stored.fingerprint).toBe(first.stored.fingerprint);
        expect(second.summary.isBaseline).toBe(false);
        expect(second.summary.rows.find((r) => r.slug === 'from-a-com')?.status).toBe('SEEN');
    });
});
