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
 * Also pins fix round 3's tightening of that rule for `fetchUrl`: a miss may only
 * be written when the *final* (render) attempt completed, not merely "at least one
 * attempt completed" — a completed-but-thin raw-http result followed by a thrown
 * render attempt must NOT write a miss, since the more capable engine never
 * actually ran. Round 2's tests covered the "at least one" property but, per
 * round 2's own re-review, never exercised this specific ordering — the two tests
 * at the bottom of the `fetchUrl` block below assert both orderings explicitly, by
 * content, not just call count.
 *
 * Also covers `Resolved.tier`, added the same round: `fetchUrl` always tags its
 * return `'path'` (it only ever tries the deterministic path tier), `findList`
 * tags `'path'` when the guess wins, `'search'` when the search wins, and `null`
 * when nothing resolves (including the known-miss short-circuit). Two independent
 * downstream needs read this field — Task 5's search-hit-only `isListPage` gate,
 * and NEW/SEEN, since a path guess resolves to the same URL every run and a
 * search does not — so it needs to actually be right, not just present.
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
        writeMiss: (...args: [string, ('thin' | 'no-match')?]) => mockWriteMiss(...args),
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

/** Clears isThin's MIN_CHARS/MIN_LINKS bar on its own, with room to spare. */
function thickMarkdown(prefix = ''): string {
    const links = Array.from({ length: 8 }, (_, i) => `[l${i}](u${i})`).join(' ');
    return `${prefix} ${'x'.repeat(850)} ${links}`;
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

    it('writes a thin-tagged miss when raw-http throws but the render retry completes thin', async () => {
        // The render attempt is the final, most capable one and it DID complete — this
        // is legitimate evidence, unlike the mirror ordering below. Asserting the call's
        // actual content (not just its count) is what makes this test able to fail: a
        // count-only assertion can't tell "writeMiss(key)" (the pre-round-2 bug) apart
        // from "writeMiss(key, 'thin')" (the current, correct call).
        outcomes = [{ throws: new Error('network blip') }, { items: [{ markdown: 'still thin' }] }];

        await fetchUrl('https://example.com/integrations');

        expect(mockWriteMiss).toHaveBeenCalledTimes(1);
        expect(mockWriteMiss).toHaveBeenCalledWith(expect.stringContaining('page-'), 'thin');
    });

    it('does NOT write a miss when raw-http completes thin but the render retry throws', async () => {
        // The mirror of the case above, and the one round 2's re-review flagged as the
        // operationally likelier and less-scrutinized ordering: render is the
        // resource-heavy engine most likely to time out or OOM. A completed-but-thin
        // raw-http result must not, by itself, justify a miss when the final, more
        // capable engine never got to run — that result alone is exactly the kind of
        // "checked one thing, learned nothing conclusive" situation an exception
        // represents, not evidence the page doesn't exist.
        outcomes = [{ items: [{ markdown: 'short' }] }, { throws: new Error('render timed out') }];

        const result = await fetchUrl('https://example.com/integrations');

        expect(result.hit).toBeNull();
        expect(mockWriteMiss).not.toHaveBeenCalled();
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

describe('Resolved.tier', () => {
    it('fetchUrl tags a resolved page as tier "path" — it only ever tries the path tier', async () => {
        outcomes = [{ items: [{ markdown: thickMarkdown() }] }];

        const result = await fetchUrl('https://example.com/integrations');

        expect(result.hit).not.toBeNull();
        expect(result.tier).toBe('path');
    });

    it('fetchUrl tags a total give-up as tier "path" too, not null', async () => {
        outcomes = [{ throws: new Error('down') }, { throws: new Error('down') }];

        const result = await fetchUrl('https://example.com/integrations');

        expect(result.hit).toBeNull();
        expect(result.tier).toBe('path');
    });

    it('findList tags a path-guess resolution as tier "path"', async () => {
        outcomes = [{ items: [{ markdown: thickMarkdown('Our integrations.') }] }];

        const result = await findList('example.com', 'integrations');

        expect(result.hit).not.toBeNull();
        expect(result.tier).toBe('path');
    });

    it('findList tags a search resolution as tier "search"', async () => {
        outcomes = [
            { items: [{ markdown: 'short' }] }, // path guess raw: thin
            { items: [{ markdown: 'short' }] }, // path guess render retry: thin
            {
                items: [
                    {
                        markdown: thickMarkdown('Our integrations.'),
                        metadata: { url: 'https://example.com/integrations-list' },
                    },
                ],
            }, // search: resolves
        ];

        const result = await findList('example.com', 'integrations');

        expect(result.hit?.url).toBe('https://example.com/integrations-list');
        expect(result.tier).toBe('search');
    });

    it('findList tags a total miss as tier null', async () => {
        outcomes = [
            { items: [{ markdown: 'short' }] }, // path guess raw: thin
            { items: [{ markdown: 'short' }] }, // path guess render retry: thin
            {
                items: [
                    { markdown: 'no relevant keyword here, just filler content', metadata: { url: 'https://example.com/blog/x' } },
                ],
            }, // search: completes, finds nothing usable
        ];

        const result = await findList('example.com', 'integrations');

        expect(result.hit).toBeNull();
        expect(result.tier).toBeNull();
    });

    it('findList tags a known-miss short-circuit as tier null and makes zero child calls', async () => {
        mockReadMiss.mockResolvedValueOnce(true); // findList's own top-level check, before the path guess even runs
        outcomes = [{ items: [{ markdown: thickMarkdown() }] }]; // would be consumed if any child call fired

        const result = await findList('example.com', 'integrations');

        expect(result.hit).toBeNull();
        expect(result.tier).toBeNull();
        expect(outcomes).toHaveLength(1); // untouched — proves no child call was made
    });
});
