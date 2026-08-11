// ---------- types ----------

export type ListKind = 'alternatives' | 'integrations';
export type SourceKind = 'peer' | 'directory';

export interface Company {
    name: string;
    domain: string;
}

export interface PageHit {
    url: string;
    markdown: string;
}

export interface SourceList {
    name: string;
    kind: SourceKind;
    names: string[];
}

/** A candidate before the LLM has described it. */
export interface RawCandidate {
    candidate: string;
    slug: string;
    peerCount: number;
    directoryCount: number;
    carriedBy: string[];
}

/** A finished output row. */
export interface Candidate extends RawCandidate {
    description: string;
    category: string;
    status: 'NEW' | 'SEEN' | 'BASELINE';
}

// ---------- constants ----------

/**
 * Verified in Task 2 Step 4. Replace this array with whatever actually returned
 * content — do not ship a URL that was not probed.
 */
export const DEFAULT_DIRECTORIES: string[] = [
    'https://n8n.io/integrations/',
    'https://python.langchain.com/docs/integrations/providers/',
    'https://composio.dev/tools',
    'https://pipedream.com/apps',
];

/**
 * One guess per kind, then search. A longer path list was tried and cut: a failed
 * fetch costs the same as a successful one, so five guesses cost ~$0.075 before the
 * search even starts, while a single-result `site:` search costs ~$0.015 and finds
 * every variant (Bright Data's `/integration`, Oxylabs' `/resources/integrations`,
 * docs subdomains). The one guess stays because it is deterministic — the same URL
 * every run is what keeps NEW/SEEN honest; search results can shift between runs.
 */
export const PATHS: Record<ListKind, string> = {
    alternatives: '/alternatives',
    integrations: '/integrations',
};

/**
 * Generic capabilities that appear on every vendor's page and are never a useful
 * candidate. Without these the output is topped by "API" and "Webhooks" every run.
 */
export const STOPWORDS = new Set([
    'api', 'rest-api', 'graphql', 'webhooks', 'webhook', 'http', 'http-request',
    'sdk', 'cli', 'email', 'csv', 'json', 'xml', 'rss', 'ftp', 'sftp',
    'custom-integration', 'other', 'more', 'all',
]);

/**
 * Names that different vendors spell differently for the same product. Without this
 * the threshold filters out true positives — "AWS S3", "Amazon S3" and "S3" each
 * land at count 1 and all three are dropped.
 */
export const ALIASES: Record<string, string> = {
    's3': 'amazon-s3',
    'aws-s3': 'amazon-s3',
    'make-com': 'make',
    'integromat': 'make',
    'postgres': 'postgresql',
    'ms-teams': 'microsoft-teams',
    'teams': 'microsoft-teams',
    'gsheets': 'google-sheets',
    'sheets': 'google-sheets',
    'gdrive': 'google-drive',
    'bigquery': 'google-bigquery',
    'gpt': 'openai',
    'chatgpt': 'openai',
};

/**
 * Decoration that vendors append to a product name. Deliberately excludes "app" and
 * "apps" — stripping those turns "Cash App" into "cash" and "Google Apps" into "google".
 */
const NOISE = new Set(['integration', 'integrations', 'connector', 'connectors', 'plugin']);

// ---------- functions ----------

/** Collapse a human-written name to a stable comparison key. */
export function normalizeName(raw: string): string {
    const words = raw
        .toLowerCase()
        .replace(/\(.*?\)/g, ' ') // "Make (formerly Integromat)" -> "make"
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);

    while (words.length > 1 && NOISE.has(words[words.length - 1])) words.pop();

    const slug = words.join('-');
    return ALIASES[slug] ?? slug;
}

/**
 * The core diff. Everything at least `minSources` sources carry that `mine` lacks,
 * ranked by how many *competitors* carry it, then by total sources.
 */
export function computeGaps(
    mine: string[],
    sources: SourceList[],
    minSources: number,
): RawCandidate[] {
    const owned = new Set(mine.map(normalizeName));
    const seen = new Map<
        string,
        { candidate: string; peers: string[]; directories: string[] }
    >();

    for (const source of sources) {
        for (const name of source.names) {
            const slug = normalizeName(name);
            if (!slug || owned.has(slug) || STOPWORDS.has(slug)) continue;

            const entry = seen.get(slug) ?? { candidate: name, peers: [], directories: [] };
            const bucket = source.kind === 'peer' ? entry.peers : entry.directories;
            if (!bucket.includes(source.name)) bucket.push(source.name);
            seen.set(slug, entry);
        }
    }

    return [...seen.entries()]
        .map(([slug, e]) => ({
            candidate: e.candidate,
            slug,
            peerCount: e.peers.length,
            directoryCount: e.directories.length,
            carriedBy: [...e.peers, ...e.directories],
        }))
        .filter((c) => c.peerCount + c.directoryCount >= minSources)
        .sort(
            (a, b) =>
                b.peerCount - a.peerCount ||
                b.directoryCount - a.directoryCount ||
                a.slug.localeCompare(b.slug),
        );
}

/** Which of the current candidates were absent last time. */
export function diffAgainstPrevious(
    previousSlugs: string[],
    currentSlugs: string[],
): Map<string, 'NEW' | 'SEEN'> {
    const before = new Set(previousSlugs);
    return new Map(currentSlugs.map((slug) => [slug, before.has(slug) ? 'SEEN' : 'NEW']));
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order.
 * Every fetch is a child Actor run of 15-40s, so a sequential loop over 25
 * competitors is a 15-minute run.
 */
export async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index]);
        }
    });

    await Promise.all(workers);
    return results;
}
