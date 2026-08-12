import { describe, expect, it, vi } from 'vitest';
import type { Company, ListKind, PageHit } from '../src/pure.js';
import { DEFAULT_DIRECTORIES, inputFingerprint } from '../src/pure.js';
import type { StoredMemory } from '../src/store.js';
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
        readCompetitors: vi.fn(async () => null),
        writeCompetitors: vi.fn(async () => undefined),
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
 * The fingerprint a run of `BASE_INPUT` produces. Stored memory carrying anything else
 * makes the run a baseline, so any test that wants a real NEW/SEEN diff must seed this.
 */
const BASE_FINGERPRINT = inputFingerprint(BASE_INPUT);

/** Stored memory for `BASE_INPUT`, fingerprinted so the next run diffs rather than rebaselines. */
function storedMemory(slugs: string[], sources: string[]): StoredMemory {
    return { slugs, sources, fingerprint: BASE_FINGERPRINT };
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
            // Memory rests on both competitors; only ok.com answered this run.
            loadPrevious: vi.fn(async () =>
                storedMemory(['flaky-only-candidate', 'stable-candidate'], ['ok.com', 'flaky.com']),
            ),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.fullCoverage).toBe(false); // flaky.com did not resolve
        expect(summary.memoryReplaced).toBe(false); // ...so memory is unioned, not superseded

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

describe('runIntegrationRadar — critical fix: the display cap must not truncate memory', () => {
    it('carries every ranked candidate into memory even when maxRows truncates what is displayed', async () => {
        const rivalHit = hit('https://rival.com/integrations');
        // Five distinct candidates, all carried by the same single source, so all tie at
        // peerCount 1 / directoryCount 0 and rankCandidates sorts them alphabetically by slug.
        const fiveNames = ['Candidate Alpha', 'Candidate Bravo', 'Candidate Charlie', 'Candidate Delta', 'Candidate Echo'];

        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);
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
        // review: `rankCandidates(...).slice(0, MAX_ROWS)` running before the slugs used
        // for `savePrevious` are computed reproduces the exact "unresolved reads as
        // removed" bug requirement 2 exists to prevent, just triggered by rank jitter
        // around the cutoff instead of a source failing to resolve. If `.slice` ever
        // moves back above the memory computation, `saved.slugs` here drops from 5 to 2
        // and this assertion fails.
        expect(savePreviousSpy).toHaveBeenCalledTimes(1);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toHaveLength(5);
    });

    it('remembers candidates below minSources, so raising the knob cannot fabricate NEW', async () => {
        // Two competitors: one carries both candidates, the other only 'shared'. At
        // minSources 2, 'lonely' is not displayed — but it must still be remembered,
        // because the README tells users to raise and lower this knob and a filtered
        // memory turns that into a wave of fabricated NEW on the next run.
        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);

        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            extractCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'A', domain: 'a.com' },
                { name: 'B', domain: 'b.com' },
            ]),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
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

        const summary = await runIntegrationRadar({ ...BASE_INPUT, minSources: 2 }, deps);

        expect(summary.rows.map((r) => r.slug)).toEqual(['shared']); // 'lonely' is filtered from display
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toContain('lonely'); // ...but not from memory
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

    it('does not replace memory when a competitor silently vanished from the extracted set', async () => {
        // The Critical hole the old `fullCoverage` gate could not see: `extractCompetitors`
        // returns one competitor fewer this run, so there is no unresolved entry at all —
        // the list is simply shorter, coverage reads "complete", and memory would be
        // replaced, erasing everything the departed competitor carried.
        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);
        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            fetchUrl: vi.fn(async (url: string): Promise<Resolved> => resolved({ hit: hit(url), key: url })),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('rival.com') ? ['Candidate One'] : ['Existing Thing'],
            ),
            loadPrevious: vi.fn(async () =>
                storedMemory(['candidate-one', 'gone-with-departed'], ['rival.com', 'departed.com', 'dir.test']),
            ),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        // Everything this run attempted resolved — the old gate would have said "replace".
        expect(summary.fullCoverage).toBe(true);
        expect(summary.memoryReplaced).toBe(false);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toContain('gone-with-departed');
    });

    it('replaces memory once a run covers every source memory rests on', async () => {
        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);
        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            fetchUrl: vi.fn(async (url: string): Promise<Resolved> => resolved({ hit: hit(url), key: url })),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('rival.com') ? ['Candidate One'] : ['Existing Thing'],
            ),
            loadPrevious: vi.fn(async () => storedMemory(['candidate-one', 'really-gone'], ['rival.com', 'dir.test'])),
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
        // Cold run: the alternatives page, the own integrations page and one competitor
        // are all fetched fresh; the placeholder directory does not resolve.
        const { deps, calls } = orderedDeps();
        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.freshSources).toBe(3);
        expect(calls).toContain('charge:source-analyzed:3');
        expect(calls).toContain(`charge:candidate-found:${summary.rows.length}`);
        expect(summary.chargedEvents).toBe(3 + summary.rows.length);
    });

    it('never charges source-analyzed for a page served from cache', async () => {
        // The guard is `if (!resolved.fromCache)`. Deleting it bills the user again for
        // every page on every warm run — the README promises the opposite.
        const { deps, calls } = orderedDeps({
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt', fromCache: true });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', fromCache: true });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival', fromCache: true });
                }
                return resolved({ hit: null, key: `${domain}-${kind}` });
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
            fetchUrl: vi.fn(async (): Promise<Resolved> => resolved({ hit: null, fromCache: true, key: 'dir' })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.freshSources).toBe(3); // alt + own + rival, not the missed directory
        expect(calls).toContain('charge:source-analyzed:3');
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
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt', fromCache: true });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', fromCache: true });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival', fromCache: true });
                }
                return resolved({ hit: null, key: `${domain}-${kind}` });
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
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt', fromCache: true });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', fromCache: true });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival', fromCache: true });
                }
                return resolved({ hit: null, key: `${domain}-${kind}` });
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
        expect(extractNamesSpy).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'https://rival.com/integrations' }));
        expect(deps.writeNames).not.toHaveBeenCalledWith('rival', expect.anything());
    });

    it('reuses the cached competitor set instead of re-deriving it from the alternatives page', async () => {
        // The one extraction with no cache: an LLM rebuilt the source set the entire
        // diff rests on, on every run including a fully warm one.
        const extractCompetitorsSpy = vi.fn(async (): Promise<Company[]> => [{ name: 'Wrong', domain: 'wrong.com' }]);
        const deps = baseDeps({
            extractCompetitors: extractCompetitorsSpy,
            readCompetitors: vi.fn(async (key: string) => (key === 'alt' ? [{ name: 'Rival', domain: 'rival.com' }] : null)),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(extractCompetitorsSpy).not.toHaveBeenCalled();
        expect(deps.writeCompetitors).not.toHaveBeenCalled();
        expect(summary.rows[0].carriedBy).toEqual(['rival.com']);
    });

    it('caches a freshly extracted competitor set against the alternatives page record', async () => {
        const deps = baseDeps();
        await runIntegrationRadar(BASE_INPUT, deps);
        expect(deps.writeCompetitors).toHaveBeenCalledWith('alt', [{ name: 'Rival', domain: 'rival.com' }]);
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

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow('No source lists could be read.');
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
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt', tier: 'path' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', tier: 'path' });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/marketing'), key: 'rival', tier: 'search' });
                }
                return resolved({ hit: null, key: `${domain}-${kind}` });
            }),
        });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow('No source lists could be read.');
        expect(isListPageSpy).not.toHaveBeenCalled();
        expect(deps.writeListPageVerdict).not.toHaveBeenCalled();
    });

    it('honours a cached acceptance without calling the LLM gate again', async () => {
        const isListPageSpy = vi.fn(async () => false);
        const deps = baseDeps({
            isListPage: isListPageSpy,
            readListPageVerdict: vi.fn(async (key: string) => (key === 'rival' ? true : null)),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt', tier: 'path' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', tier: 'path' });
                }
                if (domain === 'rival.com') {
                    return resolved({ hit: hit('https://rival.com/integrations'), key: 'rival', tier: 'search' });
                }
                return resolved({ hit: null, key: `${domain}-${kind}` });
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(isListPageSpy).not.toHaveBeenCalled();
        expect(summary.rows.map((r) => r.slug)).toEqual(['candidate-one']);
    });
});

describe('runIntegrationRadar — weakEvidence and coverage composition', () => {
    it('flags a candidate whose only support resolved via search, and not one that resolved via a path guess', async () => {
        const deps = baseDeps({
            extractCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Pathy', domain: 'pathy.com' },
                { name: 'Searchy', domain: 'searchy.com' },
            ]),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt', tier: 'path' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
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

    it('reports incomplete coverage when the peers are all fine but a directory is not', async () => {
        // `peers.fullCoverage && dirs.fullCoverage` — changing `&&` to `||` passes every
        // other test in this file, because nothing else composes the two halves.
        const deps = baseDeps({
            fetchUrl: vi.fn(async (): Promise<Resolved> => resolved({ hit: null, key: 'dir' })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.fullCoverage).toBe(false);
    });
});

describe('runIntegrationRadar — one namespace for peer and directory sources', () => {
    it('does not count a domain that is both a competitor and a directory twice', async () => {
        // `zapier.com` in both roles used to produce peerCount 1 + directoryCount 1 = 2
        // from a single page of names, clearing the default minSources: 2 on its own.
        const fetchUrlSpy = vi.fn(async (url: string): Promise<Resolved> => resolved({ hit: hit(url), key: url }));
        const deps = baseDeps({
            fetchUrl: fetchUrlSpy,
            extractCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Zapier', domain: 'zapier.com' }]),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                }
                return resolved({ hit: hit('https://zapier.com/apps'), key: 'zapier' });
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('mine.com') ? ['Existing Thing'] : ['Double Counted'],
            ),
        });

        const summary = await runIntegrationRadar(
            { ...BASE_INPUT, directories: ['https://www.zapier.com/apps'], minSources: 2 },
            deps,
        );

        // The directory is dropped before it is even fetched, so one page of names can
        // no longer clear a two-source threshold by itself.
        expect(fetchUrlSpy).not.toHaveBeenCalled();
        expect(summary.rows).toHaveLength(0);
    });

    it('records one tier per source, so a directory cannot clear a peer weakEvidence flag', async () => {
        const deps = baseDeps({
            extractCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Zapier', domain: 'zapier.com' }]),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt', tier: 'path' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own', tier: 'path' });
                }
                return resolved({ hit: hit('https://zapier.com/found-by-search'), key: 'zapier', tier: 'search' });
            }),
            fetchUrl: vi.fn(async (url: string): Promise<Resolved> => resolved({ hit: hit(url), key: url })),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('mine.com') ? ['Existing Thing'] : ['Weakly Sourced'],
            ),
        });

        const summary = await runIntegrationRadar({ ...BASE_INPUT, directories: ['https://zapier.com/apps'] }, deps);

        // The directory pass used to run second and overwrite the peer's 'search' tier
        // with 'path', silently clearing the flag.
        expect(summary.rows.find((r) => r.slug === 'weakly-sourced')?.weakEvidence).toBe(true);
    });

    it('selects the same competitors however the model orders them', async () => {
        const runWith = async (order: Company[]) => {
            const deps = baseDeps({
                extractCompetitors: vi.fn(async () => order),
                findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                    if (domain === 'mine.com' && kind === 'alternatives') {
                        return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt' });
                    }
                    if (domain === 'mine.com' && kind === 'integrations') {
                        return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                    }
                    return resolved({ hit: hit(`https://${domain}/integrations`), key: domain });
                }),
                extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                    page.url.includes('mine.com') ? ['Existing Thing'] : [`From ${new URL(page.url).hostname}`],
                ),
            });
            const summary = await runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: 2 }, deps);
            return summary.rows.map((r) => r.slug).sort();
        };

        const forwards: Company[] = [
            { name: 'A', domain: 'a.com' },
            { name: 'B', domain: 'b.com' },
            { name: 'C', domain: 'c.com' },
        ];
        // A mere reordering of the model's output used to swap which competitors were
        // read, taking the dropped one's candidates out of the run's evidence with it.
        expect(await runWith([...forwards].reverse())).toEqual(await runWith(forwards));
    });
});

describe('runIntegrationRadar — the directory pass', () => {
    /** Deps whose one competitor is `zapier.com` and whose one directory is zapier's. */
    function collidingDeps(peerResolves: boolean, overrides: Partial<Deps> = {}): Deps {
        return baseDeps({
            extractCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Zapier', domain: 'zapier.com' }]),
            findList: vi.fn(async (domain: string, kind: ListKind): Promise<Resolved> => {
                if (domain === 'mine.com' && kind === 'alternatives') {
                    return resolved({ hit: hit('https://mine.com/alternatives'), key: 'alt' });
                }
                if (domain === 'mine.com' && kind === 'integrations') {
                    return resolved({ hit: hit('https://mine.com/integrations'), key: 'own' });
                }
                // The competitor URL is a *guess* (https://zapier.com/integrations, then a
                // site-scoped search); the directory URL is hand-verified. The guess is
                // what fails here.
                return peerResolves
                    ? resolved({ hit: hit('https://zapier.com/integrations'), key: 'zapier-peer' })
                    : resolved({ hit: null, key: 'zapier-peer' });
            }),
            fetchUrl: vi.fn(async (url: string): Promise<Resolved> => resolved({ hit: hit(url), key: url })),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('mine.com') ? ['Existing Thing'] : ['Only Zapier Has This'],
            ),
            ...overrides,
        });
    }

    const ZAPIER_DIR = 'https://zapier.com/apps';

    it('still reads a directory whose competitor failed to resolve', async () => {
        // The coverage regression the dedup introduced: filtering directories against the
        // RAW competitor list dropped zapier.com/apps before it was fetched and replaced
        // it with a competitor URL guess. When that guess resolves to nothing — which is
        // exactly what happens for a domain with no /integrations page — the source was
        // lost outright rather than deduplicated. For an automation-platform user this
        // silently removes three of the seven verified default directories.
        const deps = collidingDeps(false);
        const summary = await runIntegrationRadar({ ...BASE_INPUT, directories: [ZAPIER_DIR] }, deps);

        expect(deps.fetchUrl).toHaveBeenCalledWith(ZAPIER_DIR);
        expect(summary.rows.map((r) => r.slug)).toEqual(['only-zapier-has-this']);
    });

    it('drops the directory when the same domain DID resolve as a competitor', async () => {
        // The dedup itself still has to work: one page of names must not count as two
        // independent sources.
        const deps = collidingDeps(true);
        const summary = await runIntegrationRadar({ ...BASE_INPUT, directories: [ZAPIER_DIR] }, deps);

        expect(deps.fetchUrl).not.toHaveBeenCalled();
        const row = summary.rows.find((r) => r.slug === 'only-zapier-has-this');
        expect(row?.peerCount).toBe(1);
        expect(row?.directoryCount).toBe(0);
    });

    it('never reads the analyzed company itself as a directory', async () => {
        // Its own names are what the diff subtracts; counting them as a source would let
        // the company's own page carry a candidate toward minSources.
        const deps = baseDeps({
            fetchUrl: vi.fn(async (url: string): Promise<Resolved> => resolved({ hit: hit(url), key: url })),
        });

        await runIntegrationRadar({ ...BASE_INPUT, directories: ['https://www.mine.com/integrations'] }, deps);
        expect(deps.fetchUrl).not.toHaveBeenCalled();
    });

    it('does not charge source-analyzed for a directory served from cache', async () => {
        // The one `!resolved.fromCache` guard with no coverage: no test returned a
        // fetchUrl result that was both a hit and cached, so deleting the directory
        // branch's guard billed the user for every cached directory on every warm run
        // and passed the whole suite.
        const chargeSpy = vi.fn(async (event: { eventName: string; count: number }) => ({
            chargedCount: event.count,
            eventChargeLimitReached: false,
        }));
        const deps = baseDeps({
            charge: chargeSpy,
            fetchUrl: vi.fn(
                async (url: string): Promise<Resolved> => resolved({ hit: hit(url), key: url, fromCache: true }),
            ),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('mine.com') ? ['Existing Thing'] : ['Candidate One'],
            ),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        // alt + own + rival are fresh; the directory is cached and must not be counted.
        expect(summary.freshSources).toBe(3);
        expect(chargeSpy).toHaveBeenCalledWith({ eventName: 'source-analyzed', count: 3 });
    });
});

describe('runIntegrationRadar — the fingerprint covers the effective directories', () => {
    it('treats an empty directories list and the seven defaults as the same question', async () => {
        // `directories: []` means "use DEFAULT_DIRECTORIES", so a Console user who submits
        // the prefilled seven URLs is asking exactly what an API caller passing `[]` is.
        // Fingerprinting `input.directories` instead of the resolved list splits those into
        // two memory lineages and rebaselines on a change the user never made.
        const deps = baseDeps({
            loadPrevious: vi.fn(async () => ({
                slugs: ['candidate-one'],
                sources: ['rival.com'],
                fingerprint: inputFingerprint({
                    companyDomain: 'mine.com',
                    maxCompetitors: 20,
                    directories: DEFAULT_DIRECTORIES,
                }),
            })),
        });

        const summary = await runIntegrationRadar({ ...BASE_INPUT, directories: [] }, deps);

        expect(summary.isBaseline).toBe(false);
        expect(summary.rows.find((r) => r.slug === 'candidate-one')?.status).toBe('SEEN');
    });
});
