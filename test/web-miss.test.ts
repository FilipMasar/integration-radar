import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchUrl, findIntegrations } from '../src/web.js';

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
        writeMiss: (...args: [string]) => mockWriteMiss(...args),
    };
});

vi.mock('apify', () => ({
    Actor: {
        newClient: () => ({
            actor: () => ({
                start: async () => {
                    const outcome = outcomes.shift();
                    if (!outcome) throw new Error('test bug: no mock outcome queued for this call');
                    if (outcome.throws) throw outcome.throws;
                    current = { items: outcome.items ?? [] };
                    return { id: 'child-run' };
                },
            }),
            run: () => ({
                waitForFinish: async () => ({ id: 'child-run', defaultDatasetId: 'ds' }),
                abort: async () => undefined,
            }),
            dataset: () => ({
                listItems: async () => ({ items: current?.items ?? [] }),
            }),
        }),
    },
    log: { debug: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function missCallsFor(prefix: string): unknown[][] {
    return mockWriteMiss.mock.calls.filter(([key]) => (key as string).startsWith(prefix));
}

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
        outcomes = [
            { throws: new Error('x402 payment header missing') },
            { throws: new Error('x402 payment header missing') },
        ];

        const result = await fetchUrl('https://example.com/integrations');

        expect(result.hit).toBeNull();
        expect(mockWriteMiss).not.toHaveBeenCalled();
    });

    it('DOES write a miss when every engine attempt completes but comes back thin', async () => {
        outcomes = [{ items: [{ markdown: 'short' }] }, { items: [{ markdown: 'short' }] }];

        const result = await fetchUrl('https://example.com/integrations');

        expect(result.hit).toBeNull();
        expect(mockWriteMiss).toHaveBeenCalledTimes(1);
        expect(mockWriteMiss).toHaveBeenCalledWith(expect.stringContaining('page-'));
    });

    it('does NOT write a miss when the raw fetch throws and the render retry also throws', async () => {
        outcomes = [{ throws: new Error('network blip') }, { throws: new Error('child Actor timed out') }];

        await fetchUrl('https://example.com/integrations');

        expect(mockWriteMiss).not.toHaveBeenCalled();
    });

    it('writes a miss when raw-http throws but the render retry completes thin', async () => {
        outcomes = [{ throws: new Error('network blip') }, { items: [{ markdown: 'still thin' }] }];

        await fetchUrl('https://example.com/integrations');

        expect(mockWriteMiss).toHaveBeenCalledTimes(1);
        expect(mockWriteMiss).toHaveBeenCalledWith(expect.stringContaining('page-'));
    });

    it('does NOT write a miss when raw-http completes thin but the render retry throws', async () => {
        outcomes = [{ items: [{ markdown: 'short' }] }, { throws: new Error('render timed out') }];

        const result = await fetchUrl('https://example.com/integrations');

        expect(result.hit).toBeNull();
        expect(mockWriteMiss).not.toHaveBeenCalled();
    });
});

describe('findIntegrations miss recording', () => {
    it('does NOT write a search-tier miss when the search attempt throws', async () => {
        outcomes = [
            { items: [{ markdown: 'short' }] },
            { items: [{ markdown: 'short' }] },
            { throws: new Error('network blip') },
        ];

        const result = await findIntegrations('example.com');

        expect(result.hit).toBeNull();
        expect(missCallsFor('search-')).toHaveLength(0);
    });

    it('DOES write a search-tier miss when the search completes but finds nothing that looks right', async () => {
        outcomes = [
            { items: [{ markdown: 'short' }] },
            { items: [{ markdown: 'short' }] },
            {
                items: [
                    {
                        markdown: 'no relevant keyword here, just filler content',
                        metadata: { url: 'https://example.com/blog/some-post' },
                    },
                ],
            },
        ];

        const result = await findIntegrations('example.com');

        expect(result.hit).toBeNull();
        expect(missCallsFor('search-')).toEqual([[expect.stringContaining('search-')]]);
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

    it('findIntegrations tags a path-guess resolution as tier "path"', async () => {
        outcomes = [{ items: [{ markdown: thickMarkdown('Our integrations.') }] }];

        const result = await findIntegrations('example.com');

        expect(result.hit).not.toBeNull();
        expect(result.tier).toBe('path');
    });

    it('findIntegrations tags a search resolution as tier "search"', async () => {
        outcomes = [
            { items: [{ markdown: 'short' }] },
            { items: [{ markdown: 'short' }] },
            {
                items: [
                    {
                        markdown: thickMarkdown('Our integrations.'),
                        metadata: { url: 'https://example.com/integrations-list' },
                    },
                ],
            },
        ];

        const result = await findIntegrations('example.com');

        expect(result.hit?.url).toBe('https://example.com/integrations-list');
        expect(result.tier).toBe('search');
    });

    it('findIntegrations tags a total miss as tier null', async () => {
        outcomes = [
            { items: [{ markdown: 'short' }] },
            { items: [{ markdown: 'short' }] },
            {
                items: [
                    {
                        markdown: 'no relevant keyword here, just filler content',
                        metadata: { url: 'https://example.com/blog/x' },
                    },
                ],
            },
        ];

        const result = await findIntegrations('example.com');

        expect(result.hit).toBeNull();
        expect(result.tier).toBeNull();
    });

    it('findIntegrations tags a known-miss short-circuit as tier null and makes zero child calls', async () => {
        mockReadMiss.mockResolvedValueOnce(true);
        outcomes = [{ items: [{ markdown: thickMarkdown() }] }];

        const result = await findIntegrations('example.com');

        expect(result.hit).toBeNull();
        expect(result.tier).toBeNull();
        expect(outcomes).toHaveLength(1);
    });
});
