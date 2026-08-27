import { beforeEach, describe, expect, it, vi } from 'vitest';
import { abortChildren, fetchUrl } from '../src/web.js';

const aborted: string[] = [];
const started: string[] = [];
let gates: (() => void)[] = [];
let nextId = 0;

vi.mock('../src/store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/store.js')>();
    return {
        ...actual,
        readCache: async () => null,
        writeCache: async () => undefined,
        readMiss: async () => false,
        writeMiss: async () => undefined,
    };
});

vi.mock('apify', () => ({
    Actor: {
        newClient: () => ({
            actor: () => ({
                start: async () => {
                    const id = `run-${nextId++}`;
                    started.push(id);
                    return { id };
                },
            }),
            run: (runId: string) => ({
                waitForFinish: async () => {
                    await new Promise<void>((resolve) => gates.push(resolve));
                    return { id: runId, defaultDatasetId: 'ds' };
                },
                abort: async () => {
                    aborted.push(runId);
                },
            }),
            dataset: () => ({ listItems: async () => ({ items: [] }) }),
        }),
    },
    log: { debug: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// fetchUrl retries with a second child run when the first comes back empty, so one release
// is not enough — keep going until the call under test returns.
async function drain(pending: Promise<unknown>): Promise<void> {
    let settled = false;
    void pending.then(() => {
        settled = true;
    });
    while (!settled) {
        for (const release of gates.splice(0)) release();
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
    await pending;
}

beforeEach(async () => {
    // Drop any run a previous test left live before this one can see it.
    await abortChildren();
    aborted.length = 0;
    started.length = 0;
    gates = [];
    nextId = 0;
});

describe('abortChildren', () => {
    it('aborts a child run that is still in flight', async () => {
        const pending = fetchUrl('https://example.com/integrations');
        await vi.waitFor(() => expect(started).toEqual(['run-0']));

        await abortChildren();
        expect(aborted).toEqual(['run-0']);

        await drain(pending);
    });

    it('does nothing when no child run is live', async () => {
        await abortChildren();
        expect(aborted).toEqual([]);
    });

    it('leaves a finished child alone and aborts only the live one', async () => {
        const pending = fetchUrl('https://example.com/integrations');
        await vi.waitFor(() => expect(started).toEqual(['run-0']));
        for (const release of gates.splice(0)) release();
        await vi.waitFor(() => expect(started).toEqual(['run-0', 'run-1']));

        await abortChildren();
        expect(aborted).toEqual(['run-1']);

        await drain(pending);
    });

    it('is empty again after a run completes normally', async () => {
        await drain(fetchUrl('https://example.com/integrations'));

        await abortChildren();
        expect(aborted).toEqual([]);
    });
});
