import { describe, expect, it, vi } from 'vitest';
import type { Company } from '../src/pure.js';
import { inputFingerprint } from '../src/pure.js';
import type { StoredMemory } from '../src/store.js';
import type { Deps, Input } from '../src/orchestrate.js';

vi.mock('apify', () => ({
    log: { debug: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { runIntegrationRadar } = await import('../src/orchestrate.js');

const BASE_INPUT: Input = {
    companyDomain: 'mine.com',
    maxCompetitors: 20,
};

// Every test declares the integration lists the model would return, per domain: `own` for the
// analyzed company, `competitors` for the rivals (its keys are also what the seed would name),
// and `cached` for the domains whose list is already in the key-value store.
interface Scenario {
    own?: string[];
    competitors?: Record<string, string[]>;
    cached?: Record<string, string[]>;
}

function depsFor(scenario: Scenario = {}, overrides: Partial<Deps> = {}): Deps {
    const own = scenario.own ?? ['Existing Thing'];
    const competitors = scenario.competitors ?? { 'rival.com': ['Candidate One'] };
    const cached = scenario.cached ?? {};
    const known: Record<string, string[]> = { 'mine.com': own, ...competitors };

    const base: Deps = {
        seedCompetitors: vi.fn(async (): Promise<Company[]> =>
            Object.keys(competitors).map((domain) => ({ name: domain, domain })),
        ),
        listIntegrations: vi.fn(async (domain: string): Promise<string[]> => known[domain] ?? []),
        readIntegrations: vi.fn(async (domain: string): Promise<string[] | null> => cached[domain] ?? null),
        writeIntegrations: vi.fn(async () => undefined),
        describeCandidates: vi.fn(async () => new Map()),
        readSeed: vi.fn(async () => null),
        writeSeed: vi.fn(async () => undefined),
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

// Gives every domain a candidate of its own, so which competitors were read is visible in the rows.
function oneEach(domains: string[]): Record<string, string[]> {
    return Object.fromEntries(domains.map((domain) => [domain, [`From ${domain}`]]));
}

const BASE_FINGERPRINT = inputFingerprint({ ...BASE_INPUT, competitors: ['rival.com'] });

function storedMemory(slugs: string[], sources: string[]): StoredMemory {
    return { slugs, sources, fingerprint: BASE_FINGERPRINT };
}

function storedMemoryFor(competitors: string[], slugs: string[], sources: string[]): StoredMemory {
    return { slugs, sources, fingerprint: inputFingerprint({ ...BASE_INPUT, competitors }) };
}

function savedMemory(): { spy: Deps['savePrevious']; last: () => StoredMemory } {
    const saved: StoredMemory[] = [];
    const spy = vi.fn(async (_domain: string, memory: StoredMemory) => {
        saved.push(memory);
    });
    return { spy, last: () => saved[saved.length - 1] };
}

describe('runIntegrationRadar — the company being analyzed', () => {
    it('fails when the model knows no integrations for the company itself', async () => {
        const deps = depsFor({ own: [] });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'Could not list any integrations for mine.com.',
        );
        expect(deps.pushData).not.toHaveBeenCalled();
        expect(deps.charge).not.toHaveBeenCalled();
    });

    it('excludes the analyzed company from its own competitor set', async () => {
        const memory = savedMemory();
        const deps = depsFor(
            { competitors: { 'mine.com': ['Existing Thing'], 'rival.com': ['Candidate One'] } },
            { savePrevious: memory.spy },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(memory.last().sources).toEqual(['rival.com']);
        expect(summary.rows.map((r) => r.carriedBy)).toEqual([['rival.com']]);
    });

    it('never reports the analyzed company itself as a gap, however a competitor spells it', async () => {
        const deps = depsFor({ competitors: { 'rival.com': ['Mine', 'Mine.com', 'Candidate One'] } });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows.map((r) => r.slug)).toEqual(['candidate-one']);
    });

    it('fails when the company itself was the only competitor named', async () => {
        const deps = depsFor({ competitors: { 'mine.com': ['Existing Thing'] } });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'No competitors left for mine.com after excluding the company itself.',
        );
    });
});

describe('runIntegrationRadar — a competitor with nothing to say must not fail the run', () => {
    const twoSourceMemory = () =>
        storedMemoryFor(['ok.com', 'flaky.com'], ['flaky-only-candidate', 'stable-candidate'], ['ok.com', 'flaky.com']);

    const twoCompetitors: Record<string, string[]> = {
        'ok.com': ['Stable Candidate'],
        'flaky.com': [],
    };

    it('keeps a previously-known candidate in memory when its source lists nothing this run', async () => {
        const memory = savedMemory();
        const deps = depsFor(
            { competitors: twoCompetitors },
            { savePrevious: memory.spy, loadPrevious: vi.fn(async () => twoSourceMemory()) },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.memoryReplaced).toBe(false);
        expect(memory.last().slugs).toContain('flaky-only-candidate');
        expect(memory.last().slugs).toContain('stable-candidate');
        expect(memory.last().sources).toContain('flaky.com');
        expect(summary.rows.find((r) => r.slug === 'stable-candidate')?.status).toBe('SEEN');
    });

    it('skips a competitor whose lookup throws, and still reports the others', async () => {
        const memory = savedMemory();
        const deps = depsFor(
            { competitors: { 'ok.com': ['Stable Candidate'], 'flaky.com': ['Never Reached'] } },
            {
                savePrevious: memory.spy,
                loadPrevious: vi.fn(async () => twoSourceMemory()),
                readIntegrations: vi.fn(async (domain: string): Promise<string[] | null> => {
                    if (domain === 'flaky.com') throw new Error('key-value store request failed with status 500');
                    return null;
                }),
            },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(deps.pushData).toHaveBeenCalledTimes(1);
        expect(summary.rows.map((r) => r.slug)).toContain('stable-candidate');
        expect(summary.rows.map((r) => r.slug)).not.toContain('never-reached');
        expect(summary.memoryReplaced).toBe(false);
        expect(memory.last().slugs).toContain('flaky-only-candidate');
    });

    it('fails the run when no competitor yields any integrations at all', async () => {
        const deps = depsFor({ competitors: { 'rival.com': [] } });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'No integrations could be listed for any competitor.',
        );
    });
});

describe('runIntegrationRadar — the display cap must not truncate memory', () => {
    it('carries every ranked candidate into memory even when maxRows truncates what is displayed', async () => {
        const memory = savedMemory();
        const deps = depsFor(
            {
                competitors: {
                    'rival.com': [
                        'Candidate Alpha',
                        'Candidate Bravo',
                        'Candidate Charlie',
                        'Candidate Delta',
                        'Candidate Echo',
                    ],
                },
            },
            { maxRows: 2, savePrevious: memory.spy },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows).toHaveLength(2);
        expect(deps.pushData).toHaveBeenCalledTimes(1);
        expect(vi.mocked(deps.pushData).mock.calls[0][0]).toHaveLength(2);

        expect(memory.last().slugs).toHaveLength(5);
        expect(summary.totalRanked).toBe(5);
    });

    it('reports a candidate carried by a single competitor — there is no evidence threshold', async () => {
        const deps = depsFor({ competitors: { 'a.com': ['Shared', 'Lonely'], 'b.com': ['Shared'] } });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows.map((r) => r.slug)).toEqual(['shared', 'lonely']);
        expect(summary.rows.map((r) => r.competitorCount)).toEqual([2, 1]);
    });
});

describe('runIntegrationRadar — memory describes the conditions it was gathered under', () => {
    it('reports a baseline instead of a diff when the inputs changed since the stored run', async () => {
        const memory = savedMemory();
        const deps = depsFor(
            {},
            {
                savePrevious: memory.spy,
                loadPrevious: vi.fn(async () => ({
                    slugs: ['something-else'],
                    sources: ['rival.com'],
                    fingerprint: inputFingerprint({ ...BASE_INPUT, maxCompetitors: 3 }),
                })),
            },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.isBaseline).toBe(true);
        expect(summary.rows.every((r) => r.status === 'BASELINE')).toBe(true);

        expect(memory.last().slugs).toContain('something-else');
        expect(memory.last().fingerprint).toBe(BASE_FINGERPRINT);
    });

    it('treats a pre-fingerprint stored record as a baseline rather than diffing blind', async () => {
        const deps = depsFor(
            {},
            { loadPrevious: vi.fn(async () => ({ slugs: ['candidate-one'], sources: [], fingerprint: null })) },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.isBaseline).toBe(true);
    });

    it('marks a candidate the stored run already carried as SEEN', async () => {
        const deps = depsFor({}, { loadPrevious: vi.fn(async () => storedMemory(['candidate-one'], ['rival.com'])) });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.isBaseline).toBe(false);
        expect(summary.rows.find((r) => r.slug === 'candidate-one')?.status).toBe('SEEN');
    });

    it('marks a candidate the stored run did not carry as NEW', async () => {
        const deps = depsFor({}, { loadPrevious: vi.fn(async () => storedMemory(['some-older-gap'], ['rival.com'])) });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.isBaseline).toBe(false);
        expect(summary.rows.find((r) => r.slug === 'candidate-one')?.status).toBe('NEW');
    });

    it('does not replace memory when a competitor silently vanished from the competitor set', async () => {
        const memory = savedMemory();
        const deps = depsFor(
            {},
            {
                savePrevious: memory.spy,
                loadPrevious: vi.fn(async () =>
                    storedMemory(['candidate-one', 'gone-with-departed'], ['rival.com', 'departed.com']),
                ),
            },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.memoryReplaced).toBe(false);
        expect(memory.last().slugs).toContain('gone-with-departed');
    });

    it('replaces memory once a run covers every source memory rests on', async () => {
        const memory = savedMemory();
        const deps = depsFor(
            {},
            {
                savePrevious: memory.spy,
                loadPrevious: vi.fn(async () => storedMemory(['candidate-one', 'really-gone'], ['rival.com'])),
            },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.memoryReplaced).toBe(true);
        expect(memory.last().slugs).not.toContain('really-gone');
    });
});

describe('runIntegrationRadar — charging', () => {
    function orderedDeps(scenario: Scenario = {}, overrides: Partial<Deps> = {}): { deps: Deps; calls: string[] } {
        const calls: string[] = [];
        const deps = depsFor(scenario, {
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
        const { deps, calls } = orderedDeps();
        await runIntegrationRadar(BASE_INPUT, deps);

        expect(calls[0]).toBe('pushData');
        expect(calls.filter((c) => c.startsWith('charge:'))).toHaveLength(2);
        expect(calls.indexOf('pushData')).toBeLessThan(calls.findIndex((c) => c.startsWith('charge:')));
    });

    it('charges the two advertised event names, with the counts they advertise', async () => {
        const { deps, calls } = orderedDeps();
        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.freshSources).toBe(2);
        expect(calls).toContain('charge:source-analyzed:2');
        expect(calls).toContain(`charge:candidate-found:${summary.rows.length}`);
        expect(summary.chargedEvents).toBe(2 + summary.rows.length);
    });

    it('never charges source-analyzed for a company served from cache', async () => {
        const { deps, calls } = orderedDeps({
            cached: { 'mine.com': ['Existing Thing'], 'rival.com': ['Candidate One'] },
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.freshSources).toBe(0);
        expect(calls.some((c) => c.startsWith('charge:source-analyzed'))).toBe(false);
        expect(calls).toContain(`charge:candidate-found:${summary.rows.length}`);
    });

    it('charges source-analyzed only for the companies that were not cached', async () => {
        const { deps, calls } = orderedDeps({
            competitors: oneEach(['a.com', 'b.com']),
            cached: { 'a.com': ['From a.com'] },
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.freshSources).toBe(2);
        expect(calls).toContain('charge:source-analyzed:2');
    });

    it.each([
        {
            case: 'a partial charge with the platform limit flag set',
            outcome: { chargedCount: 1, eventChargeLimitReached: true },
            chargingState: 'capped',
            chargedEvents: 2,
        },
        {
            case: 'a partial charge the platform did not flag as a limit',
            outcome: { chargedCount: 1, eventChargeLimitReached: false },
            chargingState: 'capped',
            chargedEvents: 2,
        },
        {
            case: 'a fully refused charge with the limit flag set',
            outcome: { chargedCount: 0, eventChargeLimitReached: true },
            chargingState: 'capped',
            chargedEvents: 0,
        },
        {
            case: 'a run that is simply not pay-per-event',
            outcome: { chargedCount: 0, eventChargeLimitReached: false },
            chargingState: 'inactive',
            chargedEvents: 0,
        },
    ])('reports $case as $chargingState', async ({ outcome, chargingState, chargedEvents }) => {
        const deps = depsFor({}, { charge: vi.fn(async () => outcome) });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.chargingState).toBe(chargingState);
        expect(summary.chargedEvents).toBe(chargedEvents);
    });

    it('does not call charge at all when there is nothing chargeable', async () => {
        const deps = depsFor({
            competitors: { 'rival.com': ['Existing Thing'] },
            cached: { 'mine.com': ['Existing Thing'], 'rival.com': ['Existing Thing'] },
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows).toHaveLength(0);
        expect(summary.chargingState).toBe('none');
        expect(deps.charge).not.toHaveBeenCalled();
    });
});

describe('runIntegrationRadar — the integrations cache', () => {
    it('reports the cached list, not the one the model would have listed', async () => {
        const deps = depsFor({
            competitors: { 'rival.com': ['Freshly Listed'] },
            cached: { 'rival.com': ['Cached Candidate'] },
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows.map((r) => r.slug)).toEqual(['cached-candidate']);
        expect(summary.freshSources).toBe(1);
    });

    it('caches a freshly listed set, but never an empty one that would read back as "no integrations"', async () => {
        const cache = new Map<string, string[]>();
        const store: Partial<Deps> = {
            readIntegrations: vi.fn(async (domain: string) => cache.get(domain) ?? null),
            writeIntegrations: vi.fn(async (domain: string, names: string[]) => {
                cache.set(domain, names);
            }),
        };

        const deps = depsFor({ competitors: { 'rival.com': ['Candidate One'], 'silent.com': [] } }, store);
        await runIntegrationRadar(BASE_INPUT, deps);

        expect(cache.get('mine.com')).toEqual(['Existing Thing']);
        expect(cache.get('rival.com')).toEqual(['Candidate One']);
        expect(cache.has('silent.com')).toBe(false);

        // A second run over the same cache costs no LLM calls and reports the same gaps.
        const second = depsFor({ competitors: { 'rival.com': ['Candidate One'], 'silent.com': [] } }, store);
        const summary = await runIntegrationRadar(BASE_INPUT, second);

        expect(summary.freshSources).toBe(0);
        expect(summary.rows.map((r) => r.slug)).toEqual(['candidate-one']);
    });
});

describe('runIntegrationRadar — the competitor seed', () => {
    it('reads the competitor set the cached seed holds, not one the LLM would derive', async () => {
        const deps = depsFor(
            { competitors: oneEach(['rival.com', 'wrong.com']) },
            {
                readSeed: vi.fn(async () => [{ name: 'Rival', domain: 'rival.com' }]),
                seedCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Wrong', domain: 'wrong.com' }]),
            },
        );

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows.map((r) => r.carriedBy)).toEqual([['rival.com']]);
        expect(deps.seedCompetitors).not.toHaveBeenCalled();
        expect(deps.writeSeed).not.toHaveBeenCalled();
    });

    it('derives a seed on a miss, stores it, and reuses it on the next run', async () => {
        let record: Company[] | null = null;
        const seedSpy = vi.fn(async (): Promise<Company[]> => [{ name: 'Rival', domain: 'rival.com' }]);
        const seedStore: Partial<Deps> = {
            readSeed: vi.fn(async () => record),
            writeSeed: vi.fn(async (_domain: string, _max: number, competitors: Company[]) => {
                record = competitors;
            }),
            seedCompetitors: seedSpy,
        };

        const first = await runIntegrationRadar(BASE_INPUT, depsFor({}, seedStore));
        const second = await runIntegrationRadar(BASE_INPUT, depsFor({}, seedStore));

        expect(seedSpy).toHaveBeenCalledTimes(1);
        expect(second.rows.map((r) => r.carriedBy)).toEqual(first.rows.map((r) => r.carriedBy));
    });

    it('fails with a pointer to the override when the seed is empty', async () => {
        const deps = depsFor({}, { seedCompetitors: vi.fn(async () => []) });

        await expect(runIntegrationRadar(BASE_INPUT, deps)).rejects.toThrow(
            'Could not determine competitors for mine.com. Pass them explicitly via the "competitors" input.',
        );
        expect(deps.writeSeed).not.toHaveBeenCalled();
    });

    it('uses an explicit competitors input and never touches the seed', async () => {
        const deps = depsFor(
            { competitors: oneEach(['rival.com', 'wrong.com']) },
            {
                readSeed: vi.fn(async () => [{ name: 'Wrong', domain: 'wrong.com' }]),
                seedCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Wrong', domain: 'wrong.com' }]),
            },
        );

        const summary = await runIntegrationRadar({ ...BASE_INPUT, competitors: ['rival.com'] }, deps);

        expect(summary.rows.map((r) => r.carriedBy)).toEqual([['rival.com']]);
        expect(deps.seedCompetitors).not.toHaveBeenCalled();
        expect(deps.readSeed).not.toHaveBeenCalled();
        expect(deps.writeSeed).not.toHaveBeenCalled();
    });

    it('normalizes a supplied competitor entry that is not a bare domain', async () => {
        const deps = depsFor({ competitors: oneEach(['peer.com']) });

        const summary = await runIntegrationRadar(
            { ...BASE_INPUT, competitors: ['https://www.PEER.com/pricing'] },
            deps,
        );

        expect(summary.rows.map((r) => r.slug)).toEqual(['from-peer-com']);
        expect(summary.rows[0].carriedBy).toEqual(['peer.com']);
    });

    it('drops only the unusable entries from a partly-valid supplied list', async () => {
        const deps = depsFor({ competitors: oneEach(['rival.com']) });

        const summary = await runIntegrationRadar({ ...BASE_INPUT, competitors: ['rival.com', 'not a domain'] }, deps);

        expect(summary.rows.map((r) => r.carriedBy)).toEqual([['rival.com']]);
    });

    it('rejects an explicit competitors input with no usable domain', async () => {
        await expect(runIntegrationRadar({ ...BASE_INPUT, competitors: ['not a domain'] }, depsFor())).rejects.toThrow(
            'No usable competitor domains in the "competitors" input',
        );
    });

    it('rejects a competitors input that is not an array', async () => {
        const deps = depsFor();

        await expect(
            runIntegrationRadar({ ...BASE_INPUT, competitors: 'rival.com' as unknown as string[] }, deps),
        ).rejects.toThrow('"competitors" must be an array of bare domains');
        expect(deps.listIntegrations).not.toHaveBeenCalled();
        expect(deps.charge).not.toHaveBeenCalled();
    });

    it.each([
        { value: 0, message: '"maxCompetitors" must be an integer of at least 1, got 0.' },
        { value: -1, message: '"maxCompetitors" must be an integer of at least 1, got -1.' },
        { value: 1.5, message: '"maxCompetitors" must be an integer of at least 1, got 1.5.' },
        { value: Number.NaN, message: '"maxCompetitors" must be an integer of at least 1' },
    ])('refuses maxCompetitors $value before reading or charging anything', async ({ value, message }) => {
        const deps = depsFor();

        await expect(runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: value }, deps)).rejects.toThrow(message);
        expect(deps.listIntegrations).not.toHaveBeenCalled();
        expect(deps.charge).not.toHaveBeenCalled();
    });

    it('caps a seeded competitor set at maxCompetitors', async () => {
        const deps = depsFor({ competitors: oneEach(['a.com', 'b.com', 'c.com']) });

        const summary = await runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: 2 }, deps);

        expect(summary.rows.map((r) => r.slug)).toEqual(['from-a-com', 'from-b-com']);
    });

    it('caps a supplied competitor list at maxCompetitors too', async () => {
        const deps = depsFor({ competitors: oneEach(['a.com', 'b.com', 'c.com']) });

        const summary = await runIntegrationRadar(
            { ...BASE_INPUT, maxCompetitors: 2, competitors: ['a.com', 'b.com', 'c.com'] },
            deps,
        );

        expect(summary.rows.map((r) => r.slug)).toEqual(['from-a-com', 'from-b-com']);
    });

    it('keeps the model ordering when it cuts, rather than the alphabetical one', async () => {
        const deps = depsFor({ competitors: oneEach(['zulu.com', 'alpha.com']) });

        const summary = await runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: 1 }, deps);

        expect(summary.rows.map((r) => r.slug)).toEqual(['from-zulu-com']);
    });
});

describe('runIntegrationRadar — the fingerprint covers the effective competitor set', () => {
    async function run(
        input: Input,
        previous: StoredMemory | null,
        overrides: Partial<Deps> = {},
    ): Promise<{ summary: Awaited<ReturnType<typeof runIntegrationRadar>>; stored: StoredMemory }> {
        const memory = savedMemory();
        const deps = depsFor(
            { competitors: oneEach(['a.com', 'b.com', 'c.com']) },
            { loadPrevious: vi.fn(async () => previous), savePrevious: memory.spy, ...overrides },
        );
        const summary = await runIntegrationRadar(input, deps);
        return { summary, stored: memory.last() };
    }

    it('declares a baseline when reordering an over-long supplied list changes which competitors are read', async () => {
        const first: Input = { ...BASE_INPUT, maxCompetitors: 2, competitors: ['a.com', 'b.com', 'c.com'] };
        const { stored } = await run(first, null);

        const reordered: Input = { ...first, competitors: ['c.com', 'b.com', 'a.com'] };
        const { summary } = await run(reordered, stored);

        expect(summary.isBaseline).toBe(true);
        expect(summary.rows.some((r) => r.status === 'NEW')).toBe(false);
        expect(summary.rows.find((r) => r.slug === 'from-c-com')?.status).toBe('BASELINE');
    });

    it('still diffs when the same over-long list is submitted in the same order', async () => {
        const input: Input = { ...BASE_INPUT, maxCompetitors: 2, competitors: ['a.com', 'b.com', 'c.com'] };
        const { stored } = await run(input, null);
        const { summary } = await run(input, stored);

        expect(summary.isBaseline).toBe(false);
        expect(summary.rows.find((r) => r.slug === 'from-a-com')?.status).toBe('SEEN');
    });

    it('keeps the fingerprint stable across runs on the seeded path, so a cached seed never rebaselines', async () => {
        let record: Company[] | null = null;
        const seedSpy = vi.fn(async (): Promise<Company[]> => [
            { name: 'A', domain: 'a.com' },
            { name: 'B', domain: 'b.com' },
            { name: 'C', domain: 'c.com' },
        ]);
        const seedStore: Partial<Deps> = {
            readSeed: vi.fn(async () => record),
            writeSeed: vi.fn(async (_domain: string, _max: number, competitors: Company[]) => {
                record = competitors;
            }),
            seedCompetitors: seedSpy,
        };

        const input: Input = { ...BASE_INPUT, maxCompetitors: 2 };
        const first = await run(input, null, seedStore);
        const second = await run(input, first.stored, seedStore);

        expect(seedSpy).toHaveBeenCalledTimes(1);
        expect(second.stored.fingerprint).toBe(first.stored.fingerprint);
        expect(second.summary.isBaseline).toBe(false);
        expect(second.summary.rows.find((r) => r.slug === 'from-a-com')?.status).toBe('SEEN');
    });
});
