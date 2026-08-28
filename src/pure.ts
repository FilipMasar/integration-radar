export interface Company {
    name: string;
    domain: string;
}

export interface SourceList {
    name: string;
    names: string[];
}

export interface RawCandidate {
    candidate: string;
    slug: string;
    competitorCount: number;
    carriedBy: string[];
}

export interface Candidate extends RawCandidate {
    description: string;
    category: string;
    status: 'NEW' | 'SEEN' | 'BASELINE';
}

export interface Memory {
    // The full ranked pool, not the capped rows: truncating here makes rank jitter read as NEW.
    slugs: string[];
    sources: string[];
}

// prettier-ignore
const STOPWORDS = new Set([
    'api', 'rest-api', 'graphql', 'webhooks', 'webhook', 'http', 'http-request',
    'sdk', 'cli', 'email', 'csv', 'json', 'xml', 'rss', 'ftp', 'sftp',
    'custom-integration', 'other', 'more', 'all',
]);

const ALIASES: Record<string, string> = {
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

// "app"/"apps" are left out on purpose: stripping them turns "Cash App" into "cash".
const NOISE = new Set(['integration', 'integrations', 'connector', 'connectors', 'plugin']);

export function normalizeName(raw: string): string {
    const words = raw
        .toLowerCase()
        .replace(/\(.*?\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);

    while (words.length > 1 && NOISE.has(words[words.length - 1])) words.pop();

    const slug = words.join('-');
    return ALIASES[slug] ?? slug;
}

export function sourceName(raw: string): string {
    const host = raw
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .split(/[/?#]/)[0]
        .replace(/:\d+$/, '');
    return host.replace(/^www\./, '');
}

export const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

// A company's own name reads as a gap otherwise: asked what HubSpot integrates with, a model
// answers "Mailchimp", so every competitor "carries" Mailchimp and it tops Mailchimp's own report.
// Two spellings, because the name can sit either side of the dot: browse.ai is "Browse AI".
export function ownNames(domain: string): string[] {
    const host = sourceName(domain);
    return [host.split('.')[0], host.replace(/\./g, '-')];
}

export function normalizeCompetitors(raw: { name: string; domain: string }[]): Company[] {
    const cleaned = raw
        .map((c) => ({ name: c.name.trim(), domain: sourceName(c.domain) }))
        .filter((c) => DOMAIN_RE.test(c.domain));
    // Guarded set, not `new Map(pairs)`: first entry wins, and Map.set would keep the last.
    const byDomain = new Map<string, Company>();
    for (const c of cleaned) {
        if (!byDomain.has(c.domain)) byDomain.set(c.domain, c);
    }
    return [...byDomain.values()];
}

export function rankCandidates(mine: string[], sources: SourceList[]): RawCandidate[] {
    const owned = new Set(mine.map(normalizeName));
    const seen = new Map<string, { candidate: string; carriedBy: string[] }>();

    for (const source of sources) {
        for (const name of source.names) {
            const slug = normalizeName(name);
            if (!slug || owned.has(slug) || STOPWORDS.has(slug)) continue;

            const entry = seen.get(slug) ?? { candidate: name, carriedBy: [] };
            if (!entry.carriedBy.includes(source.name)) entry.carriedBy.push(source.name);
            seen.set(slug, entry);
        }
    }

    return [...seen.entries()]
        .map(([slug, e]) => ({
            candidate: e.candidate,
            slug,
            competitorCount: e.carriedBy.length,
            carriedBy: e.carriedBy,
        }))
        .sort((a, b) => b.competitorCount - a.competitorCount || a.slug.localeCompare(b.slug));
}

// Bumped when the way integrations are gathered changes. Lists from the old page-reading pass are
// not comparable with these, so a stored history from before the change must rebaseline once rather
// than report the difference between two methods as NEW rows.
const METHOD = 2;

export function inputFingerprint(input: {
    companyDomain: string;
    maxCompetitors: number;
    competitors?: string[];
}): string {
    // Sorting is safe only because the caller passes the post-cut set it actually reads.
    return JSON.stringify({
        method: METHOD,
        companyDomain: sourceName(input.companyDomain),
        maxCompetitors: input.maxCompetitors,
        competitors: [...new Set((input.competitors ?? []).map(sourceName))].sort(),
    });
}

export function diffAgainstPrevious(previousSlugs: string[], currentSlugs: string[]): Map<string, 'NEW' | 'SEEN'> {
    const before = new Set(previousSlugs);
    return new Map(currentSlugs.map((slug) => [slug, before.has(slug) ? 'SEEN' : 'NEW']));
}

// Replace memory only when this run's sources cover the ones the stored slugs rest on; otherwise
// union, so a source that merely failed to resolve does not resurface as NEW next run.
export function mergeMemory(
    previous: Memory,
    current: Memory,
    inputsChanged: boolean,
): { memory: Memory; replaced: boolean } {
    const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

    if (inputsChanged) {
        return {
            memory: { slugs: union(previous.slugs, current.slugs), sources: current.sources },
            replaced: false,
        };
    }
    const covered = new Set(current.sources);
    if (previous.sources.every((s) => covered.has(s))) return { memory: current, replaced: true };
    return {
        memory: {
            slugs: union(previous.slugs, current.slugs),
            sources: union(previous.sources, current.sources),
        },
        replaced: false,
    };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
