import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    log: { debug: vi.fn(), info: vi.fn(), warning: vi.fn() },
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
        expect(constructorSpy).not.toHaveBeenCalled();

        await extractNames({ url: 'https://example.com/integrations', markdown: '# integrations' });

        expect(constructorSpy).toHaveBeenCalledTimes(1);
    });

    it('reads LLM_API_KEY/LLM_BASE_URL freshly at first use, not from a value captured earlier', async () => {
        const { extractNames } = await import('../src/llm.js');

        process.env.LLM_API_KEY = 'test-key-not-a-real-secret';
        process.env.LLM_BASE_URL = 'https://example.invalid/v1';

        await extractNames({ url: 'https://example.com/integrations', markdown: '# integrations' });

        expect(constructorSpy).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'test-key-not-a-real-secret', baseURL: 'https://example.invalid/v1' }),
        );
    });
});
