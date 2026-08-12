import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchUrl, findList } from '../src/web.js';

/**
 * Pins the fix for the Critical bug found in Task 4 fix round 1's re-review: a
 * thrown `runRagBrowser` call (bad token, network blip, child-Actor timeout/OOM)
 * must never be recorded as a known miss, only a call that actually completed and
 * came back thin/non-matching may be. Reading the code is not enough to trust this
 * — the whole point is that the two cases look identical from `hit === null` alone,
 * so this has to be pinned by asserting on `writeMiss`, not on the returned `hit`.
 *
 * `apify` is mocked so `runRagBrowser` (private to web.ts) never makes a real
 * network/Actor call: `Actor.newClient().actor(...).call(...)` and
 * `.dataset(...).listItems()` are driven by a queue of scripted outcomes, consumed
 * in call order. `store.js` is partially mocked — `readCache`/`readMiss` are
 * stubbed to "nothing cached, no known miss" so every test exercises the fetch
 * loop, while `writeMiss` is a spy this file asserts on. `cacheKey` is left real
 * (via importOriginal) so assertions can filter by the real key prefixes
 * ('page-' vs 'search-').
 */

interface Outcome {
    throws?: Error;
    items?: unknown[];
}

let outcomes: Outcome[] = [];
let current: { items: unknown[] } | null = null;

const mockReadCache = vi.fn(async () => null);
const mockWriteCache = vi.fn(async () => undefined);
const mockReadMiss = vi.fn(async () => false);
const mockWriteMiss = vi.fn(async () => undefined);

vi.mock('../src/store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/store.js')>();
    return {
        ...actual,
        readCache: (...args: [string]) => mockReadCache(...args),
        writeCache: (...args: [string, unknown]) => mockWriteCache(...args),
        readMiss: (...args: [string]) => mockReadMiss(...args),
        writeMiss: (...args: [string, string?]) => mockWriteMiss(...args),
    };
});

vi.mock('apify', () => ({
    Actor: {
        newClient: () => ({
            actor: () => ({
                call: async () => {
                    const outcome = outcomes.shift();
                    if (!outcome) throw new Error('test bug: no mock outcome queued for this call');
                    if (outcome.throws) throw outcome.throws;
                    current = { items: outcome.items ?? [] };
                    return { defaultDatasetId: 'ds' };
                },
            }),
            dataset: () => ({
                listItems: async () => ({ items: current?.items ?? [] }),
            }),
        }),
    },
    log: { info: vi.fn(), warning: vi.fn() },
}));

function missCallsFor(prefix: string): unknown[][] {
    return mockWriteMiss.mock.calls.filter(([key]) => (key as string).startsWith(prefix));
}

beforeEach(() => {
    outcomes = [];
    current = null;
    mockReadCache.mockClear();
    mockWriteCache.mockClear();
    mockReadMiss.mockClear();
    mockWriteMiss.mockClear();
});

describe('fetchUrl miss recording', () => {
    it('does NOT write a miss when every engine attempt throws', async () => {
        outcomes = [{ throws: new Error('x402 payment header missing') }, { throws: new Error('x402 payment header missing') }];

        const result = await fetchUrl('https://example.com/integrations');

        expect(result.hit).toBeNull();
        expect(mockWriteMiss).not.toHaveBeenCalled();
    });

    it('DOES write a miss when every engine attempt completes but comes back thin', async () => {
        outcomes = [{ items: [{ markdown: 'short' }] }, { items: [{ markdown: 'short' }] }];

        const result = await fetchUrl('https://example.com/integrations');

        expect(result.hit).toBeNull();
        expect(mockWriteMiss).toHaveBeenCalledTimes(1);
        expect(mockWriteMiss).toHaveBeenCalledWith(expect.stringContaining('page-'), 'thin');
    });

    it('does NOT write a miss when the raw fetch throws and the render retry also throws', async () => {
        outcomes = [{ throws: new Error('network blip') }, { throws: new Error('child Actor timed out') }];

        await fetchUrl('https://example.com/integrations');

        expect(mockWriteMiss).not.toHaveBeenCalled();
    });

    it('writes a miss if at least one attempt completed, even if the other threw', async () => {
        outcomes = [{ throws: new Error('network blip') }, { items: [{ markdown: 'still thin' }] }];

        await fetchUrl('https://example.com/integrations');

        expect(mockWriteMiss).toHaveBeenCalledTimes(1);
    });
});

describe('findList miss recording', () => {
    it('does NOT write a search-tier miss when the search attempt throws', async () => {
        // Path guess: both engine attempts come back thin (completed, not matching).
        // Search: throws.
        outcomes = [{ items: [{ markdown: 'short' }] }, { items: [{ markdown: 'short' }] }, { throws: new Error('network blip') }];

        const result = await findList('example.com', 'integrations');

        expect(result.hit).toBeNull();
        expect(missCallsFor('search-')).toHaveLength(0);
    });

    it('DOES write a search-tier miss when the search completes but finds nothing that looks right', async () => {
        outcomes = [
            { items: [{ markdown: 'short' }] }, // path guess raw: thin
            { items: [{ markdown: 'short' }] }, // path guess render retry: thin
            {
                items: [
                    {
                        markdown: 'no relevant keyword here, just filler content',
                        metadata: { url: 'https://example.com/blog/some-post' },
                    },
                ],
            }, // search: completes, but only an article-shaped result
        ];

        const result = await findList('example.com', 'integrations');

        expect(result.hit).toBeNull();
        expect(missCallsFor('search-')).toEqual([[expect.stringContaining('search-'), 'no-match']]);
    });
});
