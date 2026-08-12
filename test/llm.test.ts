import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageHit, RawCandidate } from '../src/pure.js';

/**
 * `openai`'s client is instantiated once at module load (`const client = new OpenAI(...)`
 * in src/llm.ts), so the mock has to be a class whose constructor result exposes a
 * `chat.completions.create` that this file controls per-test. `mockCreate` is declared
 * via `vi.hoisted` because `vi.mock` factories are hoisted above all imports (including
 * this file's own top-level `const`s), so a plain `const mockCreate = vi.fn()` above the
 * `vi.mock` call would still run after the factory needs it.
 *
 * This only fakes the network boundary (the OpenAI SDK). Everything downstream of the
 * mocked response — stripFences, JSON.parse, zod validation, the retry loop, the
 * domain-cleaning/dedup logic in extractCompetitors, the fail-open behaviour of
 * isListPage — is the real code in src/llm.ts, unmocked. `apify`'s `log` is stubbed
 * only because these tests run without `Actor.init()`.
 */
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
    default: class {
        chat = { completions: { create: mockCreate } };
    },
}));

vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn() },
}));

const { describeCandidates, extractCompetitors, extractNames, isListPage, stripFences } = await import('../src/llm.js');

function page(markdown: string, url = 'https://example.com/alternatives'): PageHit {
    return { url, markdown };
}

/** Shapes a mock OpenAI chat-completion response around a raw content string. */
function json(content: string) {
    return { choices: [{ message: { content } }] };
}

beforeEach(() => {
    mockCreate.mockReset();
});

describe('stripFences', () => {
    it('strips a ```json fenced block', () => {
        expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('strips a bare ``` fenced block with no language tag', () => {
        expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('is case-insensitive on the "json" tag', () => {
        expect(stripFences('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('leaves unfenced JSON unchanged apart from trimming', () => {
        expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
    });
});

describe('extractCompetitors', () => {
    it('parses a fenced response, normalizes a domain with a scheme and path, and keeps a confident guess', async () => {
        mockCreate.mockResolvedValueOnce(
            json(
                '```json\n' +
                    JSON.stringify({
                        competitors: [{ name: 'Jina AI', domain: 'https://jina.ai/pricing' }],
                    }) +
                    '\n```',
            ),
        );

        const result = await extractCompetitors(page('...'));

        expect(result).toEqual([{ name: 'Jina AI', domain: 'jina.ai' }]);
    });

    it('drops an entry with an empty domain rather than deriving one', async () => {
        mockCreate.mockResolvedValueOnce(
            json(JSON.stringify({ competitors: [{ name: 'Import.io', domain: '' }] })),
        );

        expect(await extractCompetitors(page('...'))).toEqual([]);
    });

    it('drops an entry whose domain does not look like a domain', async () => {
        mockCreate.mockResolvedValueOnce(
            json(JSON.stringify({ competitors: [{ name: 'Bad', domain: 'not a domain' }] })),
        );

        expect(await extractCompetitors(page('...'))).toEqual([]);
    });

    it('deduplicates entries that share a domain', async () => {
        mockCreate.mockResolvedValueOnce(
            json(
                JSON.stringify({
                    competitors: [
                        { name: 'Make', domain: 'make.com' },
                        { name: 'Make.com', domain: 'make.com' },
                    ],
                }),
            ),
        );

        const result = await extractCompetitors(page('...'));

        expect(result).toHaveLength(1);
        expect(result[0].domain).toBe('make.com');
    });

    it('retries once on an unparseable response and returns the second attempt', async () => {
        mockCreate.mockResolvedValueOnce(json('not json at all'));
        mockCreate.mockResolvedValueOnce(json(JSON.stringify({ competitors: [{ name: 'Weaviate', domain: 'weaviate.io' }] })));

        const result = await extractCompetitors(page('...'));

        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(result).toEqual([{ name: 'Weaviate', domain: 'weaviate.io' }]);
    });

    it('retries once on a schema-invalid response (wrong shape, still valid JSON)', async () => {
        mockCreate.mockResolvedValueOnce(json(JSON.stringify({ competitors: 'not-an-array' })));
        mockCreate.mockResolvedValueOnce(json(JSON.stringify({ competitors: [{ name: 'Weaviate', domain: 'weaviate.io' }] })));

        const result = await extractCompetitors(page('...'));

        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(result).toEqual([{ name: 'Weaviate', domain: 'weaviate.io' }]);
    });

    it('gives up and returns [] after two failed attempts, never a partial guess', async () => {
        mockCreate.mockResolvedValue(json('not json'));

        const result = await extractCompetitors(page('...'));

        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(result).toEqual([]);
    });

    it('calls the model with temperature 0 and json_object response format', async () => {
        mockCreate.mockResolvedValueOnce(json(JSON.stringify({ competitors: [] })));

        await extractCompetitors(page('...'));

        const args = mockCreate.mock.calls[0][0];
        expect(args.temperature).toBe(0);
        expect(args.response_format).toEqual({ type: 'json_object' });
    });
});

describe('extractNames', () => {
    it('trims whitespace, dedupes, and drops blank names', async () => {
        mockCreate.mockResolvedValueOnce(json(JSON.stringify({ names: [' Slack ', 'Slack', '', 'Google Sheets'] })));

        expect(await extractNames(page('...'))).toEqual(['Slack', 'Google Sheets']);
    });

    it('returns [] rather than throwing when both attempts fail', async () => {
        mockCreate.mockRejectedValue(new Error('network blip'));

        expect(await extractNames(page('...'))).toEqual([]);
    });
});

describe('isListPage', () => {
    it('returns false when the model judges the page not to be a list', async () => {
        mockCreate.mockResolvedValueOnce(json(JSON.stringify({ isList: false, reason: 'product marketing page' })));

        expect(await isListPage(page('...'), 'integrations')).toBe(false);
    });

    it('returns true when the model judges the page to be a list', async () => {
        mockCreate.mockResolvedValueOnce(json(JSON.stringify({ isList: true, reason: 'enumerates integrations' })));

        expect(await isListPage(page('...'), 'integrations')).toBe(true);
    });

    it('fails OPEN on an LLM error: a wrongly-kept page beats a silent false negative', async () => {
        mockCreate.mockRejectedValue(new Error('rate limited'));

        const result = await isListPage(page('...'), 'alternatives');

        // Failing open must come from completeJson genuinely giving up (both
        // attempts exhausted), not from isListPage short-circuiting on the first
        // error — otherwise this test would pass even if the retry loop were
        // silently deleted from completeJson.
        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(result).toBe(true);
    });
});

describe('describeCandidates', () => {
    function candidate(slug: string, name = slug): RawCandidate {
        return { candidate: name, slug, peerCount: 1, directoryCount: 0, carriedBy: ['x'] };
    }

    it('returns an empty map without calling the LLM for an empty candidate list', async () => {
        const result = await describeCandidates([]);

        expect(result.size).toBe(0);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('builds a map keyed by slug from a well-formed response', async () => {
        mockCreate.mockResolvedValueOnce(
            json(JSON.stringify({ described: [{ slug: 'weaviate', category: 'vector-database', description: 'A vector database.' }] })),
        );

        const result = await describeCandidates([candidate('weaviate', 'Weaviate')]);

        expect(result.get('weaviate')).toEqual({ category: 'vector-database', description: 'A vector database.' });
    });

    it('leaves a candidate the model omitted absent from the map rather than defaulting it', async () => {
        mockCreate.mockResolvedValueOnce(json(JSON.stringify({ described: [] })));

        const result = await describeCandidates([candidate('weaviate')]);

        expect(result.has('weaviate')).toBe(false);
        expect(result.size).toBe(0);
    });
});
