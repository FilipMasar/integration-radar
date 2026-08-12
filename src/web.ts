import { Actor, log } from 'apify';
import type { ListKind, PageHit } from './pure.js';
import { PATHS } from './pure.js';
import { cacheKey, readCache, writeCache } from './store.js';

const RAG_WEB_BROWSER = 'apify/rag-web-browser';

/** Below this a "page" is a nav shell, a parking page, or an error. */
const MIN_CHARS = 800;
const MIN_LINKS = 5;

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
        // 120s ceiling: a browser render of pipedream.com/apps was observed hanging
        // for ~157s during Task 2 before eventually failing. Without this, one bad
        // page stalls the whole run.
        { memory: 1024, timeout: 120 },
    );
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items as unknown as RagItem[];
}

function toPageHit(item: RagItem, fallbackUrl: string): PageHit | null {
    const markdown = item.markdown?.trim();
    if (!markdown) return null;
    return { url: item.metadata?.url ?? item.searchResult?.url ?? fallbackUrl, markdown };
}

function countLinks(markdown: string): number {
    return (markdown.match(/\]\(/g) ?? []).length;
}

/** Thin means client-rendered, a nav shell, or a parking page. */
function isThin(hit: PageHit | null): boolean {
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

    for (const render of [false, true]) {
        try {
            const items = await runRagBrowser(url, render, 1);
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
            log.warning('Fetch error', { url, render, error: (err as Error).message });
        }
    }
    return { hit: null, fromCache: false, key };
}

/** An article about integrations is not a list of them, and it passes the keyword test. */
const ARTICLE_RE = /\/(blog|news|post|posts|article|guides?|changelog|docs\/[^/]*tutorial)\//i;

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

    const looksRight = (hit: PageHit | null): hit is PageHit =>
        !isThin(hit) &&
        // Requiring the keyword for BOTH kinds is what rejects a homepage served from
        // /integrations/ — ScraperAPI does exactly this.
        hit!.markdown.toLowerCase().includes(keyword) &&
        !ARTICLE_RE.test(hit!.url);

    const guess = await fetchUrl(`https://${domain}${PATHS[kind]}`);
    if (looksRight(guess.hit)) {
        log.info('Resolved via path', { domain, kind, url: guess.hit.url });
        return guess;
    }

    const key = cacheKey('search', `${domain}-${kind}`);
    const cached = await readCache(key);
    if (cached) return { hit: cached, fromCache: true, key };

    try {
        // Two results, not one: the top hit is sometimes an article rather than the list.
        const items = await runRagBrowser(`site:${domain} ${kind}`, false, 2);
        for (const item of items) {
            const hit = toPageHit(item, `https://${domain}`);
            if (looksRight(hit)) {
                log.info('Resolved via search', { domain, kind, url: hit.url });
                await writeCache(key, hit);
                return { hit, fromCache: false, key };
            }
        }
    } catch (err) {
        log.warning('Search error', { domain, kind, error: (err as Error).message });
    }

    log.warning('No list found', { domain, kind });
    return { hit: null, fromCache: false, key };
}
