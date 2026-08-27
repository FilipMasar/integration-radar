import { describe, expect, it, vi } from 'vitest';
import type { Company, PageHit } from '../src/pure.js';
import { inputFingerprint } from '../src/pure.js';
import type { StoredMemory } from '../src/store.js';
import type { Resolved } from '../src/web.js';
import type { Deps, Input } from '../src/orchestrate.js';

vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn() },
}));

const { runIntegrationRadar } = await import('../src/orchestrate.js');
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

const BASE_FINGERPRINT = inputFingerprint({ ...BASE_INPUT, competitors: ['rival.com'] });

function storedMemory(slugs: string[], sources: string[]): StoredMemory {
    return { slugs, sources, fingerprint: BASE_FINGERPRINT };
}

function storedMemoryFor(competitors: string[], slugs: string[], sources: string[]): StoredMemory {
    return { slugs, sources, fingerprint: inputFingerprint({ ...BASE_INPUT, competitors }) };
}

describe('runIntegrationRadar — requirement 1: gate search-tier hits, not path-tier hits', () => {
    it('calls isListPage for a search-tier hit and not for a path-tier hit', async () => {
        const ownHit = hit('https://mine.com/integrations');
        const pathHit = hit('https://rival.com/integrations');
        const searchHit = hit('https://searchfound.com/some-other-page');

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
            isListPage: vi.fn(async () => false),
        });

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
                if (domain === 'flaky.com') return resolved({ hit: null, key: 'flaky' });
                return resolved({ hit: null, key: domain });
            }),
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url.includes('mine.com')) return ['Existing Thing'];
                if (page.url === okHit.url) return ['Stable Candidate'];
                return [];
            }),
            loadPrevious: vi.fn(async () =>
                storedMemoryFor(
                    ['ok.com', 'flaky.com'],
                    ['flaky-only-candidate', 'stable-candidate'],
                    ['ok.com', 'flaky.com'],
                ),
            ),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.memoryReplaced).toBe(false);

        expect(savePreviousSpy).toHaveBeenCalledTimes(1);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toContain('flaky-only-candidate');
        expect(saved.slugs).toContain('stable-candidate');
        expect(saved.sources).toContain('flaky.com');

        expect(summary.rows.find((r) => r.slug === 'stable-candidate')?.status).toBe('SEEN');
    });
});

describe('runIntegrationRadar — one competitor failing must not fail the run', () => {
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

        expect(pushDataSpy).toHaveBeenCalledTimes(1);
        expect(summary.rows.map((r) => r.slug)).toContain('stable-candidate');

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
            maxRows: 2,
            savePrevious: savePreviousSpy,
            pushData: pushDataSpy,
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> => {
                if (page.url === rivalHit.url) return fiveNames;
                return ['Existing Thing'];
            }),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows).toHaveLength(2);
        expect(pushDataSpy).toHaveBeenCalledTimes(1);
        expect(pushDataSpy.mock.calls[0][0]).toHaveLength(2);

        expect(savePreviousSpy).toHaveBeenCalledTimes(1);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).toHaveLength(5);
        expect(summary.totalRanked).toBe(5);
    });

    it('reports a candidate carried by a single competitor — there is no evidence threshold', async () => {
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
        const savePreviousSpy = vi.fn(async (_domain: string, _memory: StoredMemory) => undefined);
        const deps = baseDeps({
            savePrevious: savePreviousSpy,
            extractNames: vi.fn(async (page: PageHit): Promise<string[]> =>
                page.url.includes('rival.com') ? ['Candidate One'] : ['Existing Thing'],
            ),
            loadPrevious: vi.fn(async () =>
                storedMemory(['candidate-one', 'gone-with-departed'], ['rival.com', 'departed.com']),
            ),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

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
            loadPrevious: vi.fn(async () => storedMemory(['candidate-one', 'really-gone'], ['rival.com'])),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.memoryReplaced).toBe(true);
        const [, saved] = savePreviousSpy.mock.calls[0];
        expect(saved.slugs).not.toContain('really-gone');
    });
});

describe('runIntegrationRadar — charging', () => {
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

    it('never charges source-analyzed for a page served from cache', async () => {
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
        expect(summary.freshSources).toBe(2);
        expect(calls).toContain('charge:source-analyzed:2');
    });

    it('reports an under-charge instead of swallowing it', async () => {
        const deps = baseDeps({
            charge: vi.fn(async () => ({ chargedCount: 1, eventChargeLimitReached: true })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.chargingState).toBe('capped');
        expect(summary.chargedEvents).toBe(2);
    });

    it('reports a partial charge as capped even when the platform did not set the limit flag', async () => {
        const deps = baseDeps({
            charge: vi.fn(async () => ({ chargedCount: 1, eventChargeLimitReached: false })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.chargingState).toBe('capped');
        expect(summary.chargedEvents).toBe(2);
    });

    it('reports a fully refused charge as capped when the platform set the limit flag', async () => {
        const deps = baseDeps({
            charge: vi.fn(async () => ({ chargedCount: 0, eventChargeLimitReached: true })),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);
        expect(summary.chargingState).toBe('capped');
        expect(summary.chargedEvents).toBe(0);
    });

    it('reports a non-pay-per-event run as inactive, not as a budget cap', async () => {
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

        expect(summary.rows).toHaveLength(0);
        expect(deps.charge).not.toHaveBeenCalled();
    });
});

describe('runIntegrationRadar — cache reuse at the orchestration layer', () => {
    it('reuses cached names instead of paying for the extraction again', async () => {
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
        const deps = baseDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [{ name: 'Wrong', domain: 'wrong.com' }]),
            readSeed: vi.fn(async () => [{ name: 'Rival', domain: 'rival.com' }]),
        });

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.rows[0].carriedBy).toEqual(['rival.com']);
    });

    it('caches freshly extracted names against the page record they came from', async () => {
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

        expect(summary.rows.find((r) => r.slug === 'search-only')?.weakEvidence).toBe(true);
        expect(summary.rows.find((r) => r.slug === 'path-only')?.weakEvidence).toBe(false);
    });
});

describe('runIntegrationRadar — step 1: the competitor seed', () => {
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

        await runIntegrationRadar({ ...BASE_INPUT, competitors: ['https://www.PEER.com/pricing'] }, deps);

        expect(deps.findIntegrations).toHaveBeenCalledWith('peer.com');
    });

    it('drops only the unusable entries from a partly-valid supplied list', async () => {
        vi.mocked(log.warning).mockClear();
        const deps = baseDeps();

        await runIntegrationRadar({ ...BASE_INPUT, competitors: ['rival.com', 'not a domain'] }, deps);

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
        const deps = baseDeps();

        await expect(
            runIntegrationRadar({ ...BASE_INPUT, competitors: 'rival.com' as unknown as string[] }, deps),
        ).rejects.toThrow('"competitors" must be an array of bare domains');
        expect(deps.findIntegrations).not.toHaveBeenCalled();
        expect(deps.charge).not.toHaveBeenCalled();
    });

    it('excludes the analyzed company from its own competitor set', async () => {
        const deps = baseDeps({
            seedCompetitors: vi.fn(async (): Promise<Company[]> => [
                { name: 'Mine', domain: 'mine.com' },
                { name: 'Rival', domain: 'rival.com' },
            ]),
        });

        await runIntegrationRadar(BASE_INPUT, deps);

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

        expect(deps.findIntegrations).toHaveBeenCalledTimes(3);
        expect(deps.findIntegrations).not.toHaveBeenCalledWith('c.com');
        expect(log.warning).toHaveBeenCalledWith('Competitor list truncated', { found: 3, maxCompetitors: 2 });
    });

    it('refuses a maxCompetitors below 1 instead of capping the set to nothing', async () => {
        const deps = baseDeps();

        await expect(runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: 0 }, deps)).rejects.toThrow(
            '"maxCompetitors" must be an integer of at least 1, got 0.',
        );
        expect(deps.findIntegrations).not.toHaveBeenCalled();
        expect(deps.charge).not.toHaveBeenCalled();
    });

    it('refuses a maxCompetitors that is not a whole number', async () => {
        await expect(runIntegrationRadar({ ...BASE_INPUT, maxCompetitors: Number.NaN }, baseDeps())).rejects.toThrow(
            '"maxCompetitors" must be an integer of at least 1',
        );
    });

    it('keeps the model ordering when it cuts, rather than the alphabetical one', async () => {
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

        expect(deps.findIntegrations).toHaveBeenCalledTimes(3);
        expect(deps.findIntegrations).not.toHaveBeenCalledWith('c.com');
        expect(log.warning).toHaveBeenCalledWith('Competitor list truncated', { found: 3, maxCompetitors: 2 });
    });

    it('does not charge source-analyzed for the seed', async () => {
        const deps = baseDeps();

        const summary = await runIntegrationRadar(BASE_INPUT, deps);

        expect(summary.freshSources).toBe(2);
    });
});

describe('runIntegrationRadar — the fingerprint covers the effective competitor set', () => {
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
        const seeded: Company[] = [
            { name: 'A', domain: 'a.com' },
            { name: 'B', domain: 'b.com' },
            { name: 'C', domain: 'c.com' },
        ];
        let seedRecord: Company[] | null = null;
        const seedSpy = vi.fn(async () => seeded);
        const persistentSeed: Partial<Deps> = {
            readSeed: vi.fn(async () => seedRecord),
            writeSeed: vi.fn(async (_domain: string, _max: number, competitors: Company[]) => {
                seedRecord = competitors;
            }),
            seedCompetitors: seedSpy,
        };

        const input: Input = { ...BASE_INPUT, maxCompetitors: 2 };
        const first = await run(input, null, persistentSeed);
        const second = await run(input, first.stored, persistentSeed);

        expect(seedSpy).toHaveBeenCalledTimes(1);
        expect(second.stored.fingerprint).toBe(first.stored.fingerprint);
        expect(second.summary.isBaseline).toBe(false);
        expect(second.summary.rows.find((r) => r.slug === 'from-a-com')?.status).toBe('SEEN');
    });
});
