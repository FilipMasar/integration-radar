import { Actor, log } from 'apify';

import type { PageHit } from './pure.js';
import { INTEGRATIONS_PATH } from './pure.js';
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

export interface Resolved {
    hit: PageHit | null;
    fromCache: boolean;
    /**
     * The cache record this page lives in. Callers need it to attach extracted names to
     * the same record; it cannot be derived from `hit.url`, because a page found via
     * search is stored under the search key, not its own URL.
     */
    key: string;
    /**
     * Which tier produced the hit. The `isListPage` gate runs on search hits only, and a
     * `NEW` finding sourced from a search hit is weaker evidence — a path guess resolves to
     * the same URL every run, a search does not (`brightdata.com` resolved to two different
     * URLs on consecutive runs).
     *
     * **`tier` describes which mechanism ran, not whether it succeeded — always check
     * `hit !== null` first.** `fetchUrl` returns `'path'` even when it gives up, because
     * the path tier is the only mechanism it has.
     */
    tier: 'path' | 'search' | null;
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
        // The timeout bounds the damage of a hang; the memory addresses its cause. Both
        // live Playwright renders logged "Memory is critically overloaded (95%)", almost
        // certainly the mechanism behind the ~157s pipedream.com/apps hang that motivated
        // the timeout. Only the retry path pays the higher rate; raw-http fetches are cheap
        // and never approach that ceiling.
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
 * Fetch one URL as Markdown, cheap engine first. If the raw fetch comes back thin, retry
 * once with a real browser — `zyte.com/integrations` returns HTTP 200 with zero visible
 * text on a plain fetch, and it was not the only competitor page that did.
 */
export async function fetchUrl(url: string): Promise<Resolved> {
    const key = cacheKey('page', url);
    const cached = await readCache(key);
    if (cached) {
        log.info('Cache hit', { url });
        return { hit: cached, fromCache: true, key, tier: 'path' };
    }

    if (await readMiss(key)) {
        return { hit: null, fromCache: true, key, tier: 'path' };
    }

    // A miss may only be recorded once the render attempt — the final, most capable engine
    // — has itself completed and come back unusable. "At least one attempt completed" is
    // not tight enough: it would let a thin raw-http result justify a miss even when the
    // render retry threw and never ran, resting the miss on the weaker engine while the
    // more dispositive one produced no information at all. Render is also the call far more
    // likely to time out or OOM, so "raw completed thin, render threw" is the operationally
    // relevant ordering. Resetting the flag each iteration means it reflects only the last
    // attempt: an exception is an absence of information, not evidence of absence.
    let finalAttemptCompleted = false;
    for (const render of [false, true]) {
        finalAttemptCompleted = false;
        try {
            const items = await runRagBrowser(url, render, 1);
            finalAttemptCompleted = true;
            const hit = items.length ? toPageHit(items[0], url) : null;
            if (!isThin(hit)) {
                log.info('Fetched', { url, render, chars: hit!.markdown.length });
                await writeCache(key, hit!);
                return { hit, fromCache: false, key, tier: 'path' };
            }
            log.info('Thin result', { url, render, chars: hit?.markdown.length ?? 0 });
        } catch (err) {
            // A bad token and a missing page look identical downstream, so log loudly
            // rather than swallowing. Must NOT leave `finalAttemptCompleted` set.
            log.warning('Fetch error', { url, render, error: (err as Error).message });
        }
    }
    if (finalAttemptCompleted) await writeMiss(key);
    return { hit: null, fromCache: false, key, tier: 'path' };
}

/** An article about integrations is not a list of them, and it passes the keyword test. */
export const ARTICLE_RE = /\/(blog|news|post|posts|article|guides?|changelog|docs\/[^/]*tutorial)\//i;

/**
 * Whether a fetched page is actually the list it claims to be, rather than a homepage, an
 * article mentioning the keyword, or a thin shell. Requiring the keyword is what rejects a
 * homepage served from `/integrations/` — ScraperAPI does exactly this. Takes `keyword` as
 * an argument rather than reading it from the caller's scope so it is testable alone.
 */
export function looksRight(hit: PageHit | null, keyword: string): hit is PageHit {
    return !isThin(hit) && hit!.markdown.toLowerCase().includes(keyword) && !ARTICLE_RE.test(hit!.url);
}

/**
 * One path guess, then a site-scoped search. The guess is cheap and deterministic; the
 * search covers every naming variant without us enumerating them.
 */
export async function findIntegrations(domain: string): Promise<Resolved> {
    const keyword = 'integrat';
    // This key format is not a free choice — existing stored records must keep hitting.
    const key = cacheKey('search', `${domain}-integrations`);

    // Checked before the path guess, so a domain known to have neither a guessable nor a
    // findable page costs zero child calls rather than just a cheaper search-tier miss.
    if (await readMiss(key)) {
        return { hit: null, fromCache: true, key, tier: null };
    }

    const guess = await fetchUrl(`https://${domain}${INTEGRATIONS_PATH}`);
    if (looksRight(guess.hit, keyword)) {
        log.info('Resolved via path', { domain, url: guess.hit.url });
        return guess; // already tier: 'path', set by fetchUrl
    }

    const cached = await readCache(key);
    if (cached) return { hit: cached, fromCache: true, key, tier: 'search' };

    // Same rule as `fetchUrl`: only a search that completed and found nothing counts as a
    // miss. A thrown search must leave no marker.
    let searchCompleted = false;
    try {
        // Two results, not one: the top hit is sometimes an article rather than the list.
        const items = await runRagBrowser(`site:${domain} integrations`, false, 2);
        searchCompleted = true;
        for (const item of items) {
            const hit = toPageHit(item, `https://${domain}`);
            if (looksRight(hit, keyword)) {
                log.info('Resolved via search', { domain, url: hit.url });
                await writeCache(key, hit);
                return { hit, fromCache: false, key, tier: 'search' };
            }
        }
    } catch (err) {
        log.warning('Search error', { domain, error: (err as Error).message });
    }

    log.warning('No list found', { domain });
    if (searchCompleted) await writeMiss(key);
    return { hit: null, fromCache: false, key, tier: null };
}
