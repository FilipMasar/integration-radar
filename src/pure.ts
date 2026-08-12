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

/**
 * What a run persists so the *next* run can tell NEW from SEEN.
 *
 * Two fields, and the second one is the whole point: a bag of slugs with no record of
 * the conditions it was gathered under cannot be diffed honestly. `sources` says what
 * evidence `slugs` rests on, so `mergeMemory` can tell "this candidate is gone" apart
 * from "we did not look where it lives this time."
 */
export interface Memory {
    /**
     * Every candidate this run found *any* evidence for — the full ranked pool, before
     * the `minSources` display filter and before the display row cap. What we remember
     * and what we display are different things: `minSources` and the row cap are
     * presentation knobs, and letting either of them shrink memory turns a knob-twiddle
     * into a wave of fabricated `NEW` on the next run.
     */
    slugs: string[];
    /**
     * The normalized names (see `sourceName`) of every source that actually resolved and
     * contributed names — i.e. exactly the evidence base `slugs` was computed from.
     * On a union merge this accumulates, so it always describes what the *stored* slugs
     * rest on, not just what the last run happened to read.
     */
    sources: string[];
}

// ---------- constants ----------

/**
 * Verified in Task 2 Step 4 (see task-2-report.md for full measurements). Every URL
 * here returned >2,000 chars and >30 links on at least one probe. `composio.dev/tools`
 * was dropped: both raw-http and browser-playwright returned the same 175 chars / 2
 * links, so no engine clears the bar. `make.com` (0 chars raw-http) needs browser
 * rendering and cleared the bar reliably under browser-playwright (18,261 chars/124
 * links). `pipedream.com` (9 chars raw-http) also needs rendering and cleared the bar
 * on one browser-playwright sample (6,705 chars/97 links) — but that page is flaky
 * under Playwright: a separate probe of the same pipedream.com/apps URL hung for
 * ~157s before failing, the observation that later shaped `runRagBrowser`'s
 * render-path timeout in `web.ts`. Kept anyway, on the strength of the one successful
 * sample plus the shipped fetch path's built-in degrade-to-null-hit on failure — but
 * unlike `make.com`, its coverage is not guaranteed on every run. `docs.llamaindex.ai`
 * clears the bar only narrowly (3,649 chars/39 links vs. the 2,000/30 minimums) and
 * was kept anyway: the margin is still comfortable (+82%/+30%), not razor-thin, and it
 * is the only AI-framework connector directory outside LangChain, so the added fetch
 * cost (one call per uncached run) buys real coverage.
 */
export const DEFAULT_DIRECTORIES: string[] = [
    'https://n8n.io/integrations/',
    'https://zapier.com/apps',
    'https://www.make.com/en/integrations',
    'https://pipedream.com/apps',
    'https://python.langchain.com/docs/integrations/providers/',
    'https://docs.llamaindex.ai/en/stable/module_guides/loading/connector/modules/',
    'https://smithery.ai/',
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
 * Collapse a competitor domain or a directory URL to the one name both kinds of source
 * are tracked under.
 *
 * Peer sources are minted from `competitor.domain` and directory sources from a URL's
 * hostname, by two code paths that never see each other. Before this existed they shared
 * a namespace without sharing a spelling: `zapier.com` as both a competitor and a
 * directory counted as two independent sources for the same page of names (clearing the
 * default `minSources: 2` on its own), and `www.make.com` vs `make.com` did the same
 * without even colliding on the string. `tierBySource` is keyed by this name too, so the
 * collision also silently overwrote a peer's `'search'` tier and cleared `weakEvidence`.
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

/**
 * The full ranked candidate pool: everything any source carries that `mine` lacks,
 * ranked by how many *competitors* carry it, then by total sources.
 *
 * Memory is computed from this unfiltered pool (see `Memory.slugs`); the display list is
 * the `minSources`-filtered slice of it, which `runIntegrationRadar` derives inline. Those
 * are deliberately two different things — filtering before memory turns a knob-twiddle
 * into a wave of fabricated NEW.
 */
export function rankCandidates(mine: string[], sources: SourceList[]): RawCandidate[] {
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
        .sort(
            (a, b) =>
                b.peerCount - a.peerCount ||
                b.directoryCount - a.directoryCount ||
                a.slug.localeCompare(b.slug),
        );
}

/**
 * A stable string identifying the inputs that determine *what a run looks at*.
 *
 * Memory keyed on `companyDomain` alone says nothing about the conditions it was
 * gathered under, so the next run diffs against a picture taken through a different
 * lens and calls the difference `NEW`. When this string changes, the run is a fresh
 * baseline rather than a comparison — see `runIntegrationRadar`.
 *
 * `minSources` is deliberately NOT part of it. Memory now holds the full ranked pool
 * (`Memory.slugs`), so `minSources` changes only what is displayed and can never move a
 * slug in or out of memory — fingerprinting it would force a pointless baseline run.
 */
export function inputFingerprint(input: {
    companyDomain: string;
    maxCompetitors: number;
    directories: string[];
}): string {
    return JSON.stringify({
        companyDomain: sourceName(input.companyDomain),
        maxCompetitors: input.maxCompetitors,
        // Sorted and deduped: reordering the same list is not a different question.
        directories: [...new Set(input.directories.map((u) => u.trim().toLowerCase().replace(/\/+$/, '')))].sort(),
    });
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
 * Splits `mapLimit`'s per-item results into the ones that resolved and a flag for
 * whether *every* item resolved.
 *
 * `fullCoverage` is observability only — it is logged and returned in `RunSummary` so a
 * reader can see how blind a run was. It is deliberately NOT the gate on replacing
 * memory any more; see `mergeMemory` for why "every source *attempted this run*
 * resolved" is the wrong question.
 */
export function partitionResolved<T>(results: (T | null)[]): { items: T[]; fullCoverage: boolean } {
    return {
        items: results.filter((r): r is T => r !== null),
        fullCoverage: results.every((r) => r !== null),
    };
}

/**
 * Decides what to persist as "what we knew last run" for the next run's NEW/SEEN tag.
 *
 * **The problem.** Measured across three consecutive runs against identical domains:
 * `brightdata.com` resolved twice and then came back NOT FOUND; `zyte.com` returned a
 * wrong page, then correctly nothing, then the wrong page again. Nothing changed
 * upstream — this is search flakiness and browser-render flakiness, not the world
 * changing. If a source fails to resolve, any candidate that depended on it silently
 * falls out of this run's slugs (`rankCandidates` only aggregates positive evidence; it
 * has no way to distinguish "gone" from "the source that carried it didn't answer this
 * time"). Naively overwriting memory would then forget that candidate, and the next time
 * the flaky source resolves, `diffAgainstPrevious` tags it `NEW` a second time — a
 * source that merely failed to resolve reads as "these integrations are new," which is
 * exactly backwards.
 *
 * **Why the old `fullCoverage` gate was not enough.** It certified that every source
 * *attempted this run* resolved. It said nothing about whether this run attempted the
 * same sources as last run. A competitor dropped before the resolution loop even starts
 * — by `extractCompetitors` nondeterminism, by a `maxCompetitors` cut, or by the user
 * passing a different `directories` list — never becomes an unresolved entry; the list
 * is simply shorter. Coverage then reads "complete", memory is replaced, and every
 * candidate whose only support was the dropped source comes back `NEW` the run after.
 *
 * **The rule.** Compare evidence bases, not attempt outcomes. Memory may be replaced
 * only when this run's resolved sources are a superset of the sources the *stored* slugs
 * rest on — i.e. we looked everywhere memory came from and more. Otherwise union, and
 * union the source bases too, so the basis always describes the slugs actually held (a
 * source that contributed three runs ago is still part of what memory rests on).
 *
 * `inputsChanged` (see `inputFingerprint`) forces a union — the caller also reports that
 * run as a baseline, so no `NEW` is displayed — but resets the source basis to this
 * run's, because the previous configuration's sources are not coming back and leaving
 * them in the basis would freeze memory forever.
 *
 * ---
 *
 * **What this gate certifies, and what it does not.** It is stronger than `fullCoverage`
 * against the three triggers above, but it is NOT strictly safer overall, and it does not
 * close the fabricated-`NEW` problem. Read the limits before trusting it further than
 * they allow.
 *
 * 1. **It certifies source *availability*, not source *content*.** The superset test is
 *    at source-*name* granularity: it says "we read `rival.com` again", not "we read the
 *    same page and extracted the same names from it". A search-tier competitor that
 *    resolves to a *different* page than last run (`brightdata.com` did exactly this
 *    across two consecutive runs, per this codebase's own measurements) still satisfies
 *    the test, so memory is replaced and every candidate only the better page carried is
 *    erased — returning as `NEW` when that page comes back. The same holds with no URL
 *    change at all: past the 24h page TTL the page is refetched and re-extracted, and an
 *    LLM listing 95 names does not return the identical 95 every time.
 *
 *    **This class is newly reachable, and it is the trade this design makes.** Under
 *    `fullCoverage` the replace branch essentially never fired, so memory only ever grew
 *    and content instability could not erase anything. This gate is *designed* to fire
 *    routinely — that is what makes the removal property real instead of aspirational —
 *    and firing routinely is exactly what makes this class live. The trade is: a class of
 *    content-jitter `NEW` in exchange for removals actually dropping out. Deliberate, and
 *    the right call for this Actor, but it is a trade and not a fix.
 *
 * 2. **It governs memory, not the tag.** `diffAgainstPrevious` reads `previous.slugs`
 *    whatever this function decides. So this stops run N's *loss* of memory from becoming
 *    run N+1's `NEW`; it does nothing about run N's *gain*. If `extractCompetitors`
 *    returns one competitor more than last run — at least as likely as one fewer — or a
 *    source that missed last run resolves this run, the basis has only grown, the
 *    superset test still passes, and every name only that new source carries is tagged
 *    `NEW`. Nothing changed in the world; we looked somewhere new. `weakEvidence` catches
 *    only the search-tier subset of this.
 *
 * 3. **The basis accumulates, so the removal property decays.** `sources` is
 *    monotonically non-decreasing across unions and only resets on a replace or a
 *    fingerprint change. With the flaky coverage this codebase documents, it grows toward
 *    the union of everything ever seen while any single run resolves a subset, so the
 *    superset test starts failing routinely and behaviour degrades back to union-only.
 *    **Terminal case:** if any source in the basis becomes permanently unresolvable (a
 *    competitor shuts down, a directory 404s for good, the model stops naming a
 *    competitor that had contributed), the test can never be satisfied again and memory
 *    for that domain is frozen forever — it only grows, removals never drop out, and
 *    nothing reports it. The direction is safe and it is still strictly better than the
 *    old gate, which was in that locked state from run 1; the escape today is a
 *    `maxCompetitors`/`directories` change, at the cost of one `BASELINE` run. The cheap
 *    real fix, if this bites: store the basis as `{name, lastSeenRun}` and require
 *    coverage only of entries seen within the last N runs.
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
