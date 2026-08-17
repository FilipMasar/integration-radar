export interface Company {
    name: string;
    domain: string;
}

export interface PageHit {
    url: string;
    markdown: string;
}

/** One competitor's integrations page, reduced to the names on it. */
export interface SourceList {
    name: string;
    names: string[];
}

/** A candidate before the LLM has described it. */
export interface RawCandidate {
    candidate: string;
    slug: string;
    /** How many competitors carry it. Always equal to `carriedBy.length`, kept as its own
     *  field so the dataset table can sort and display it. */
    competitorCount: number;
    carriedBy: string[];
}

/** A finished output row. */
export interface Candidate extends RawCandidate {
    description: string;
    category: string;
    status: 'NEW' | 'SEEN' | 'BASELINE';
}

/** What a run persists so the next run can tell NEW from SEEN. */
export interface Memory {
    /**
     * Every candidate with any evidence at all — the full ranked pool, before the display
     * cap. Truncating before memory would make rank jitter around the cutoff read as NEW.
     */
    slugs: string[];
    /**
     * Normalized names (see `sourceName`) of the sources `slugs` rests on, so
     * `mergeMemory` can tell "this candidate is gone" from "we did not look where it
     * lives this time".
     */
    sources: string[];
}

/**
 * The one path guessed before falling back to a site-scoped search. One guess, not a
 * list: a failed fetch costs as much as a successful one, so five guesses cost more than
 * the search they avoid. Being deterministic is what keeps NEW/SEEN honest.
 */
export const INTEGRATIONS_PATH = '/integrations';

/**
 * Generic capabilities that appear on every vendor's page. Without these the output is
 * topped by "API" and "Webhooks" every run.
 */
// prettier-ignore
const STOPWORDS = new Set([
    'api', 'rest-api', 'graphql', 'webhooks', 'webhook', 'http', 'http-request',
    'sdk', 'cli', 'email', 'csv', 'json', 'xml', 'rss', 'ftp', 'sftp',
    'custom-integration', 'other', 'more', 'all',
]);

/**
 * One product, many spellings. Without this "AWS S3", "Amazon S3" and "S3" become three
 * separate rows at `competitorCount: 1`, instead of one row carried by three competitors —
 * splitting the evidence for a candidate across the spellings used to describe it.
 */
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

/**
 * Decoration vendors append to a product name. Excludes "app" and "apps" deliberately —
 * stripping those turns "Cash App" into "cash".
 */
const NOISE = new Set(['integration', 'integrations', 'connector', 'connectors', 'plugin']);

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
 * Collapse a competitor domain to the one name a source is tracked under, so `www.a.com`,
 * `https://a.com/x` and `a.com` cannot count as separate sources for the same page.
 */
export function sourceName(raw: string): string {
    const host = raw
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
        .split(/[/?#]/)[0]
        .replace(/:\d+$/, ''); // port
    return host.replace(/^www\./, '');
}

/** A plausible bare domain — only has to reject prose, empty strings and non-domains. */
export const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/**
 * Clean a model- or user-supplied competitor list into usable records.
 *
 * Anything still not a plausible domain after `sourceName` is dropped, never repaired: a
 * derived domain costs a real fetch and can land on a parked page that returns HTTP 200
 * (`importio.com` is exactly this). Deduped by domain, first entry winning.
 */
export function normalizeCompetitors(raw: { name: string; domain: string }[]): Company[] {
    const cleaned = raw
        .map((c) => ({ name: c.name.trim(), domain: sourceName(c.domain) }))
        .filter((c) => DOMAIN_RE.test(c.domain));
    // Guarded set rather than `new Map(pairs)`: Map.set keeps the last write, we want the first.
    const byDomain = new Map<string, Company>();
    for (const c of cleaned) {
        if (!byDomain.has(c.domain)) byDomain.set(c.domain, c);
    }
    return [...byDomain.values()];
}

/**
 * Everything the competitors carry that `mine` lacks, ranked by how many of them carry
 * it. Ties break alphabetically so the order is stable between runs.
 */
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

/**
 * A stable string identifying what a run looks at. Memory gathered under a different
 * fingerprint was taken through a different lens, so the run reports a baseline instead
 * of diffing it — see `runIntegrationRadar`.
 *
 * `competitors` is the set the run *effectively* reads, post-cut, not what arrived in the
 * input. Fingerprinting the raw input would let the pages actually read change without
 * the fingerprint moving.
 */
export function inputFingerprint(input: {
    companyDomain: string;
    maxCompetitors: number;
    competitors?: string[];
}): string {
    // Sorted and deduped: reordering the same list is not a different question. Safe only
    // because the caller passes the set it actually reads, so sorting here cannot hide a
    // change in which entries survived the cut.
    return JSON.stringify({
        companyDomain: sourceName(input.companyDomain),
        maxCompetitors: input.maxCompetitors,
        competitors: [...new Set((input.competitors ?? []).map(sourceName))].sort(),
    });
}

/** Which of the current candidates were absent last time. */
export function diffAgainstPrevious(previousSlugs: string[], currentSlugs: string[]): Map<string, 'NEW' | 'SEEN'> {
    const before = new Set(previousSlugs);
    return new Map(currentSlugs.map((slug) => [slug, before.has(slug) ? 'SEEN' : 'NEW']));
}

/**
 * Decides what to persist as "what we knew last run".
 *
 * **The problem.** Search and browser rendering are flaky: measured across three
 * consecutive runs, `brightdata.com` resolved twice then not at all. A source that fails
 * to resolve takes every candidate it carried out of this run's slugs, because
 * `rankCandidates` only aggregates positive evidence. Overwriting memory would forget
 * those candidates, and the next successful run would tag them `NEW` — a source that
 * merely failed to answer reading as "these integrations are new".
 *
 * **The rule.** Compare evidence bases, not attempt outcomes. Replace memory only when
 * this run's resolved sources are a superset of the sources the *stored* slugs rest on.
 * Otherwise union both, so the basis always describes the slugs actually held.
 * `inputsChanged` forces a union — the caller reports that run as a baseline — but resets
 * the basis, since the previous configuration's sources are not coming back.
 *
 * **What it does not certify.**
 * 1. *Availability, not content.* The superset test is at source-name granularity. A
 *    search-tier source resolving to a different page than last run still passes it, so
 *    memory is replaced and names only the better page carried come back as `NEW`. This
 *    is the trade: content-jitter `NEW` in exchange for removals actually dropping out.
 * 2. *Memory, not the tag.* This stops run N's memory *loss* becoming run N+1's `NEW`; it
 *    does nothing about run N's *gain*. A source added since last run still tags
 *    everything only it carries as `NEW`.
 * 3. *The basis only grows*, so the removal property decays. If a source becomes
 *    permanently unresolvable the test can never pass again and memory for that domain is
 *    frozen — it grows, removals never drop out, and nothing reports it. Escape today is
 *    a `maxCompetitors` or `competitors` change, at the cost of one baseline run; the
 *    real fix, if it bites, is storing the basis as `{name, lastSeenRun}`.
 */
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

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order. Every fetch is
 * a child Actor run of 15-40s, so a sequential loop over 25 competitors is a 15-minute run.
 */
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
