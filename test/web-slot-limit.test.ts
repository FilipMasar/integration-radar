import { log } from 'apify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchUrl } from '../src/web.js';

let startAttempts = 0;
let failuresLeft = 0;
let failureType = 'concurrent-runs-limit-exceeded';
const missWrites: string[] = [];

// Long enough and linked enough to clear `isThin`, so a successful start ends the fetch.
const PAGE = `${']('.repeat(5)}${'x'.repeat(900)}`;

vi.mock('../src/store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/store.js')>();
    return {
        ...actual,
        readCache: async () => null,
        writeCache: async () => undefined,
        readMiss: async () => false,
        writeMiss: async (key: string) => {
            missWrites.push(key);
        },
    };
});

vi.mock('apify', () => ({
    Actor: {
        newClient: () => ({
            actor: () => ({
                start: async () => {
                    startAttempts += 1;
                    if (failuresLeft > 0) {
                        failuresLeft -= 1;
                        throw Object.assign(new Error('rejected'), { type: failureType, statusCode: 402 });
                    }
                    return { id: 'child-run' };
                },
            }),
            run: () => ({
                waitForFinish: async () => ({ id: 'child-run', defaultDatasetId: 'ds' }),
                abort: async () => undefined,
            }),
            dataset: () => ({
                listItems: async () => ({ items: [{ markdown: PAGE, metadata: { url: 'https://example.com/x' } }] }),
            }),
        }),
    },
    log: { debug: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// The retry sleeps on real wall-clock time, so step the fake clock until the call settles.
async function settle<T>(pending: Promise<T>): Promise<T> {
    let done = false;
    void pending.then(
        () => (done = true),
        () => (done = true),
    );
    while (!done) await vi.advanceTimersByTimeAsync(1_000);
    return pending;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(log.warning).mockClear();
    startAttempts = 0;
    failuresLeft = 0;
    failureType = 'concurrent-runs-limit-exceeded';
    missWrites.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('concurrent-run limit', () => {
    it('waits for a slot instead of reporting the page as missing', async () => {
        failuresLeft = 3;

        const resolved = await settle(fetchUrl('https://example.com/integrations'));

        expect(startAttempts).toBe(4);
        expect(resolved.hit?.markdown).toBe(PAGE);
        expect(missWrites).toEqual([]);
    });

    it('gives up after the deadline without recording a miss', async () => {
        failuresLeft = Number.MAX_SAFE_INTEGER;

        const resolved = await settle(fetchUrl('https://example.com/integrations'));

        expect(resolved.hit).toBeNull();
        // A source we never managed to read is unknown, not known-absent: a miss would cache the
        // rejection and keep the next run from retrying it.
        expect(missWrites).toEqual([]);
        expect(vi.mocked(log.warning).mock.calls.map((c) => c[0])).toContain(
            'Gave up waiting for a free Actor run slot — this source is unread, not absent',
        );
    });

    it('does not retry an error that is not the slot limit', async () => {
        failuresLeft = Number.MAX_SAFE_INTEGER;
        failureType = 'record-not-found';

        const resolved = await settle(fetchUrl('https://example.com/integrations'));

        expect(resolved.hit).toBeNull();
        // One start per render pass, no retries in between.
        expect(startAttempts).toBe(2);
        expect(missWrites).toEqual([]);
    });
});
