import { Actor, log } from 'apify';
import type { ListKind, PageHit } from './pure.js';
import { PATHS } from './pure.js';
import { cacheKey, readCache, readMiss, writeCache, writeMiss } from './store.js';

const RAG_WEB_BROWSER = 'apify/rag-web-browser';

/** Below this a "page" is a nav shell, a parking page, or an error. */
export const MIN_CHARS = 800;
export const MIN_LINKS = 5;

interface RagItem {
    markdown?: string;
    metadata?: { url?: string };
    searchResult?: { url?: string };
}

/**
 * `key` is the cache record this page lives in. Callers need it to attach the extracted
 * names to the same record — it cannot be derived from `hit.url`, because a page found
 * via search is stored under the search key, not its own URL.
 */
export interface Resolved {
    hit: PageHit | null;
    fromCache: boolean;
    key: string;
}

async function runRagBrowser(query: string, render: boolean, maxResults: number): Promise<RagItem[]> {
    const client = Actor.newClient();
    const run = await client.actor(RAG_WEB_BROWSER).call(
        {
            query,
            maxResults,
            outputFormats: ['markdown'],
            scrapingTool: render ? 'browser-playwright' : 'raw-http',
        },
        // The timeout bounds the damage of a hang; the memory addresses its cause.
        // Both live Playwright renders in verification logged "Memory is critically
        // overloaded. Using 976 MB of 1024 MB (95%)" — almost certainly the actual
        // mechanism behind the ~157s pipedream.com/apps hang that motivated the
        // timeout in the first place, not an unrelated fluke. Only the retry path
        // (render === true) pays the higher rate; raw-http fetches, which are cheap
        // and never approach that ceiling, stay at 1024 MB.
        render ? { memory: 4096, timeout: 180 } : { memory: 1024, timeout: 60 },
    );
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items as unknown as RagItem[];
}

function toPageHit(item: RagItem, fallbackUrl: string): PageHit | null {
    const markdown = item.markdown?.trim();
    if (!markdown) return null;
    return { url: item.metadata?.url ?? item.searchResult?.url ?? fallbackUrl, markdown };
}

export function countLinks(markdown: string): number {
    return (markdown.match(/\]\(/g) ?? []).length;
}

/** Thin means client-rendered, a nav shell, or a parking page. */
export function isThin(hit: PageHit | null): boolean {
    return !hit || hit.markdown.length < MIN_CHARS || countLinks(hit.markdown) < MIN_LINKS;
}

/**
 * Fetch one URL as Markdown, cheap engine first. If the raw fetch comes back thin,
 * retry once with a real browser — zyte.com/integrations returns HTTP 200 with zero
 * visible text on a plain fetch, and several directories are the same.
 */
export async function fetchUrl(url: string): Promise<Resolved> {
    const key = cacheKey('page', url);
    const cached = await readCache(key);
    if (cached) {
        log.info('Cache hit', { url });
        return { hit: cached, fromCache: true, key };
    }

    // Skip straight past a domain that failed both engines recently — this also
    // covers Task 6's fixed directory URLs, not just findList's own callers.
    if (await readMiss(key)) {
        return { hit: null, fromCache: true, key };
    }

    // A miss may only be recorded once an attempt actually completed and came back
    // unusable — an exception is an absence of information, not evidence of absence.
    // Without this flag, a transient failure (bad token, network blip, the child
    // Actor itself timing out or OOMing) would be indistinguishable from a genuine
    // "no page here" and would get cached as one for MISS_TTL_HOURS. This project's
    // own history shows that failure mode is not hypothetical: an entire session
    // once had every child call fail with "x402 payment header missing" because the
    // token wasn't loaded, which under the naive version of this code would have
    // poisoned the cache for every domain touched that session.
    let completed = false;
    for (const render of [false, true]) {
        try {
            const items = await runRagBrowser(url, render, 1);
            completed = true;
            const hit = items.length ? toPageHit(items[0], url) : null;
            if (!isThin(hit)) {
                log.info('Fetched', { url, render, chars: hit!.markdown.length });
                await writeCache(key, hit!);
                return { hit, fromCache: false, key };
            }
            log.info('Thin result', { url, render, chars: hit?.markdown.length ?? 0 });
        } catch (err) {
            // A thrown error here is ambiguous: a bad token and a missing page look
            // identical downstream, so log loudly rather than swallowing silently.
            // It must NOT set `completed` — see the comment above the loop.
            log.warning('Fetch error', { url, render, error: (err as Error).message });
        }
    }
    if (completed) await writeMiss(key, 'thin');
    return { hit: null, fromCache: false, key };
}

/** An article about integrations is not a list of them, and it passes the keyword test. */
export const ARTICLE_RE = /\/(blog|news|post|posts|article|guides?|changelog|docs\/[^/]*tutorial)\//i;

/**
 * Whether a fetched page is actually the list it claims to be, not a homepage, an
 * article that happens to mention the keyword, or a thin shell. Requiring the keyword
 * for BOTH `kind`s is what rejects a homepage served from `/integrations/` —
 * ScraperAPI does exactly this. Exported (and taking `keyword` as a plain argument
 * rather than closing over `kind`) so it's unit-testable on its own.
 */
export function looksRight(hit: PageHit | null, keyword: string): hit is PageHit {
    return !isThin(hit) && hit!.markdown.toLowerCase().includes(keyword) && !ARTICLE_RE.test(hit!.url);
}

/**
 * One path guess, then a site-scoped search. The guess is cheap and deterministic;
 * the search covers every naming variant without us enumerating them.
 *
 * An llms.txt tier was designed and cut (an extra fetch on every miss to save a search
 * on ~1 domain in 7), as was a five-path guess list (a failed fetch costs the same as a
 * successful one, so five guesses cost more than the search they were avoiding).
 */
export async function findList(domain: string, kind: ListKind): Promise<Resolved> {
    const keyword = kind === 'alternatives' ? 'alternativ' : 'integrat';
    const key = cacheKey('search', `${domain}-${kind}`);

    // Checked before the path guess even runs, so a domain already known to have
    // neither a guessable page nor a findable one via search costs zero child calls
    // on this run, not just a cheaper miss on the search tier alone.
    if (await readMiss(key)) {
        return { hit: null, fromCache: true, key };
    }

    const guess = await fetchUrl(`https://${domain}${PATHS[kind]}`);
    if (looksRight(guess.hit, keyword)) {
        log.info('Resolved via path', { domain, kind, url: guess.hit.url });
        return guess;
    }

    const cached = await readCache(key);
    if (cached) return { hit: cached, fromCache: true, key };

    // Same rule as fetchUrl: only a search that actually completed and found nothing
    // usable counts as a miss. A thrown search (auth, network, the child Actor
    // itself failing) must leave no marker — see fetchUrl's comment for why.
    let searchCompleted = false;
    try {
        // Two results, not one: the top hit is sometimes an article rather than the list.
        const items = await runRagBrowser(`site:${domain} ${kind}`, false, 2);
        searchCompleted = true;
        for (const item of items) {
            const hit = toPageHit(item, `https://${domain}`);
            if (looksRight(hit, keyword)) {
                log.info('Resolved via search', { domain, kind, url: hit.url });
                await writeCache(key, hit);
                return { hit, fromCache: false, key };
            }
        }
    } catch (err) {
        log.warning('Search error', { domain, kind, error: (err as Error).message });
    }

    log.warning('No list found', { domain, kind });
    if (searchCompleted) await writeMiss(key, 'no-match');
    return { hit: null, fromCache: false, key };
}
