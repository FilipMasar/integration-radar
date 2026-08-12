import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for a real bug found in Task 5 fix round 1's review: `src/llm.ts`
 * used to construct its OpenAI client at module load —
 * `const client = new OpenAI({ apiKey: process.env.LLM_API_KEY ?? process.env.APIFY_TOKEN, ... })`
 * evaluated as soon as the module was imported. ESM import evaluation runs *before* the
 * importing module's own body does, so `src/dev.ts`'s `process.loadEnvFile('.env')` call
 * had not run yet by the time `llm.ts` read those env vars — the client was built with no
 * credentials and the real `openai` package throws `OpenAIError: Missing credentials`
 * immediately in its constructor. `src/llm.ts` was unimportable at all outside the Apify
 * platform (where the platform sets env before the process starts, which is why this
 * never showed up in production or in `pnpm test`, only when actually running `dev.ts`).
 *
 * This file does NOT reuse test/llm.test.ts's `openai` mock, because that mock's
 * constructor is a no-op that would happily "succeed" whether construction happened at
 * import time or first use — it can't distinguish the two, so it can't catch this bug.
 * Instead the mock class's constructor itself is the probe (`constructorSpy`): if
 * `src/llm.ts` still built the client eagerly, merely importing the module would call
 * it before any exported function is ever invoked.
 *
 * `vi.resetModules()` per test forces a fresh evaluation of `src/llm.ts` on each
 * `import()`, so the module-level `client` singleton from one test can't leak into (and
 * mask) the next.
 */
const constructorSpy = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn(async () => ({ choices: [{ message: { content: '{"names":[]}' } }] })));

vi.mock('openai', () => ({
    default: class {
        chat = { completions: { create: mockCreate } };
        constructor(opts: unknown) {
            constructorSpy(opts);
        }
    },
}));

vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn() },
}));

const ENV_KEYS = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'APIFY_TOKEN'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    vi.resetModules();
    constructorSpy.mockClear();
    mockCreate.mockClear();
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

describe('OpenAI client construction timing', () => {
    it('does NOT construct the client merely by importing the module, even with no credentials in env', async () => {
        await import('../src/llm.js');

        expect(constructorSpy).not.toHaveBeenCalled();
    });

    it('constructs the client lazily, on the first call that actually needs it', async () => {
        const { extractNames } = await import('../src/llm.js');
        expect(constructorSpy).not.toHaveBeenCalled(); // still true right up to the call

        await extractNames({ url: 'https://example.com/integrations', markdown: '# integrations' });

        expect(constructorSpy).toHaveBeenCalledTimes(1);
    });

    it('reads LLM_API_KEY/LLM_BASE_URL freshly at first use, not from a value captured earlier', async () => {
        const { extractNames } = await import('../src/llm.js');

        // Set the env AFTER import, mimicking process.loadEnvFile running after llm.ts's
        // own module body has already executed — exactly the ordering that broke before.
        process.env.LLM_API_KEY = 'test-key-not-a-real-secret';
        process.env.LLM_BASE_URL = 'https://example.invalid/v1';

        await extractNames({ url: 'https://example.com/integrations', markdown: '# integrations' });

        expect(constructorSpy).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'test-key-not-a-real-secret', baseURL: 'https://example.invalid/v1' }),
        );
    });
});
