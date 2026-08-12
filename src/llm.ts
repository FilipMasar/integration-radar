import { log } from 'apify';
import OpenAI from 'openai';
import { z } from 'zod';

import type { Company, ListKind, PageHit, RawCandidate } from './pure.js';

/**
 * Defaults to Apify's OpenRouter Actor — OpenAI-compatible, billed as platform usage,
 * no second API key. The env overrides exist because that endpoint may only accept
 * calls originating inside the platform; see Task 2 Step 3.
 */
const client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL ?? 'https://openrouter.apify.actor/api/v1',
    apiKey: process.env.LLM_API_KEY ?? process.env.APIFY_TOKEN,
});

const MODEL = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.5';

/** Pages are large and the list is not always near the top; this is a cost ceiling. */
const MAX_CHARS = 40_000;

/** Anthropic models have no native json_object mode, so fenced replies are likely. */
export function stripFences(raw: string): string {
    return raw
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
}

async function completeJson<T>(prompt: string, schema: z.ZodSchema<T>, system: string): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await client.chat.completions.create({
                model: MODEL,
                // Without temperature 0, NEW/SEEN measures sampling noise, not change.
                temperature: 0,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: prompt },
                ],
                response_format: { type: 'json_object' },
            });

            const parsed = schema.safeParse(JSON.parse(stripFences(res.choices[0]?.message?.content ?? '')));
            if (parsed.success) return parsed.data;
            log.warning('LLM response failed validation', { attempt, error: parsed.error.message.slice(0, 200) });
        } catch (err) {
            log.warning('LLM call failed', { attempt, error: (err as Error).message.slice(0, 200) });
        }
    }
    return null;
}

const EXTRACT_SYSTEM = 'You extract structured data from web pages. Reply with JSON only.';

const CompetitorsSchema = z.object({
    competitors: z.array(z.object({ name: z.string(), domain: z.string() })),
});

export async function extractCompetitors(page: PageHit): Promise<Company[]> {
    const result = await completeJson(
        `This Markdown is from ${page.url}, where a company compares itself to competitors.

List every competing company named. Give each one's name and its primary website domain
as a bare domain, no scheme or path.

Only give a domain you are confident about. Some are not what they look like: Jina AI is
jina.ai (not jinaai.com), Browse AI is browse.ai, Import.io is import.io, Make is make.com.
If you are not confident, use an empty string rather than guessing.

Exclude the company that owns this page. Exclude product categories.

Reply as {"competitors": [{"name": "...", "domain": "..."}]}

---
${page.markdown.slice(0, MAX_CHARS)}`,
        CompetitorsSchema,
        EXTRACT_SYSTEM,
    );

    if (!result) return [];

    const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
    const cleaned = result.competitors
        .map((c) => ({
            name: c.name.trim(),
            domain: c.domain
                .trim()
                .toLowerCase()
                .replace(/^https?:\/\//, '')
                .replace(/\/.*$/, ''),
        }))
        // Drop anything without a valid domain rather than deriving one. A derived
        // domain costs real money to probe and can land on a parked page that returns
        // 200 — importio.com is exactly this.
        .filter((c) => DOMAIN_RE.test(c.domain));

    const unique = [...new Map(cleaned.map((c) => [c.domain, c])).values()];
    log.info('Extracted competitors', { found: result.competitors.length, usable: unique.length });
    return unique;
}

const NamesSchema = z.object({ names: z.array(z.string()) });

/** Used for both a company's integrations page and a directory listing — same job. */
export async function extractNames(page: PageHit): Promise<string[]> {
    const result = await completeJson(
        `This Markdown is from ${page.url}, a page listing third-party services, apps,
tools or integrations.

List the name of every third-party product or service on the page. Use each one's own
canonical name ("Google Sheets", not "Sheets integration").

Exclude the page owner's own products and features. Exclude navigation links, pricing
tiers, blog posts, and generic capabilities such as "API", "Webhooks" or "CSV export".

Reply as {"names": ["...", "..."]}

---
${page.markdown.slice(0, MAX_CHARS)}`,
        NamesSchema,
        EXTRACT_SYSTEM,
    );

    if (!result) return [];
    const cleaned = [...new Set(result.names.map((s) => s.trim()).filter(Boolean))];
    log.info('Extracted names', { count: cleaned.length, url: page.url });
    return cleaned;
}

const IsListSchema = z.object({ isList: z.boolean(), reason: z.string() });

/**
 * The search-tier gate. A site-scoped search returns whatever ranks, and a vendor's own
 * marketing page mentions "integrations" constantly — zyte.com/zyte-api/ cleared every
 * heuristic Task 4 has (21,516 chars, keyword present, not an article URL) while being a
 * product pitch, not a list. Only the model can tell those apart cheaply.
 *
 * Called ONLY for search-resolved hits. Path-guess hits skip it: they are deterministic
 * and already pinned to the URL we guessed, so a call would confirm what we know.
 *
 * Fails OPEN — on an LLM error `completeJson` returns null and we keep the page. A page
 * wrongly kept costs one extraction and shows up as noise a reader can see; a page wrongly
 * dropped is invisible, and silent false negatives are the worse failure for this Actor.
 */
export async function isListPage(page: PageHit, kind: ListKind): Promise<boolean> {
    const what =
        kind === 'alternatives'
            ? 'a list of competing or alternative products'
            : 'a list of third-party integrations, apps or connectors';

    const result = await completeJson(
        `Does this page primarily present ${what}?

Answer false if it is a product marketing or landing page, a pricing page, a docs
homepage, a blog post, or a general overview that merely mentions such things.
Answer true only if enumerating them is the page's main purpose.

Reply as {"isList": true|false, "reason": "..."}

---
${page.markdown.slice(0, 6000)}`,
        IsListSchema,
        EXTRACT_SYSTEM,
    );

    if (!result) return true; // fail open — see above
    if (!result.isList) log.info('Rejected non-list page', { url: page.url, reason: result.reason });
    return result.isList;
}

const DescriptionsSchema = z.object({
    described: z.array(z.object({ slug: z.string(), category: z.string(), description: z.string() })),
});

/**
 * Says what each candidate *is*. It does not judge whether it is worth doing —
 * that is the reader's call, and a model has no basis for it.
 */
export async function describeCandidates(
    candidates: RawCandidate[],
): Promise<Map<string, { description: string; category: string }>> {
    const out = new Map<string, { description: string; category: string }>();
    if (candidates.length === 0) return out;

    const result = await completeJson(
        `For each product or service below, give a short factual description and a category.

${candidates.map((c) => `- ${c.slug} (${c.candidate})`).join('\n')}

- category: short kebab-case bucket (vector-database, automation-platform, crm,
  ai-framework, data-warehouse, messaging, storage, observability, browser, ...)
- description: one sentence, max 15 words, saying what it is. No marketing language,
  no opinion about whether anyone should integrate with it. If you do not recognise
  the name, say "Unknown." rather than inventing something.

Return every slug exactly as given. Reply as
{"described": [{"slug": "...", "category": "...", "description": "..."}]}`,
        DescriptionsSchema,
        'You write short factual product descriptions. Reply with JSON only.',
    );

    for (const d of result?.described ?? []) {
        out.set(d.slug, { description: d.description, category: d.category });
    }

    const missing = candidates.length - out.size;
    if (missing > 0) log.warning('Some candidates undescribed', { count: missing });
    return out;
}
