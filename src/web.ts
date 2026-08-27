import { Actor, log } from 'apify';

import type { PageHit } from './pure.js';
import { INTEGRATIONS_PATH } from './pure.js';
import { cacheKey, readCache, readMiss, writeCache, writeMiss } from './store.js';

const RAG_WEB_BROWSER = 'apify/rag-web-browser';

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
    key: string;
    // Which mechanism ran, not whether it worked — always check `hit !== null` first.
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
        // Live renders logged "memory critically overloaded" at the default; the timeout bounds a hang.
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

export function isThin(hit: PageHit | null): boolean {
    return !hit || hit.markdown.length < MIN_CHARS || countLinks(hit.markdown) < MIN_LINKS;
}

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

    // Reset each pass: only the render attempt completing and coming back unusable justifies a miss.
    // A thrown attempt is an absence of information, not evidence of absence.
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
            log.warning('Fetch error', { url, render, error: (err as Error).message });
        }
    }
    if (finalAttemptCompleted) await writeMiss(key);
    return { hit: null, fromCache: false, key, tier: 'path' };
}

export const ARTICLE_RE = /\/(blog|news|post|posts|article|guides?|changelog|docs\/[^/]*tutorial)\//i;

export function looksRight(hit: PageHit | null, keyword: string): hit is PageHit {
    return !isThin(hit) && hit!.markdown.toLowerCase().includes(keyword) && !ARTICLE_RE.test(hit!.url);
}

export async function findIntegrations(domain: string): Promise<Resolved> {
    const keyword = 'integrat';
    // This key format is not a free choice — changing it orphans every stored search record.
    const key = cacheKey('search', `${domain}-integrations`);

    if (await readMiss(key)) {
        return { hit: null, fromCache: true, key, tier: null };
    }

    const guess = await fetchUrl(`https://${domain}${INTEGRATIONS_PATH}`);
    if (looksRight(guess.hit, keyword)) {
        log.info('Resolved via path', { domain, url: guess.hit.url });
        return guess;
    }

    const cached = await readCache(key);
    if (cached) return { hit: cached, fromCache: true, key, tier: 'search' };

    let searchCompleted = false;
    try {
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
