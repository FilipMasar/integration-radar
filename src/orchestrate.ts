import { log } from 'apify';

import type { describeCandidates, extractCompetitors, extractNames, isListPage } from './llm.js';
import type { Candidate, ListKind, SourceList } from './pure.js';
import {
    computeGaps,
    DEFAULT_DIRECTORIES,
    diffAgainstPrevious,
    mapLimit,
    mergePreviousSlugs,
    partitionResolved,
} from './pure.js';
import type {
    loadPrevious,
    readListPageVerdict,
    readNames,
    savePrevious,
    writeListPageVerdict,
    writeNames,
} from './store.js';
import type { fetchUrl, findList, Resolved } from './web.js';

export interface Input {
    companyDomain: string;
    maxCompetitors: number;
    directories: string[];
    minSources: number;
}

/** A finished output row, `Candidate` plus the search-tier weak-evidence flag. */
export interface OutputRow extends Candidate {
    /**
     * True when at least one source carrying this candidate resolved via the search
     * tier rather than a deterministic path guess. Search hits are not stable run to
     * run, so a NEW tag resting on search-tier evidence deserves a reader's extra
     * scrutiny rather than the same confidence as a path-hit-backed one.
     */
    weakEvidence: boolean;
}

export interface RunSummary {
    rows: OutputRow[];
    freshSources: number;
    fullCoverage: boolean;
    isBaseline: boolean;
    totalRanked: number;
}

/**
 * Every external boundary the pipeline touches, as injectable functions.
 *
 * This module (`orchestrate.ts`) exists specifically so this function is importable
 * with no side effects: `main.ts`'s top level calls `Actor.init()` and
 * `Actor.getInput()` the moment it runs, which would fire on `import` alone and make
 * the module untestable. Splitting the pipeline out means a test can `import
 * { runIntegrationRadar } from '../src/orchestrate.js'`, build a fake `Deps`, and call
 * it directly — no module mocking, no live Actor environment required.
 *
 * Pure helpers (`mapLimit`, `computeGaps`, `diffAgainstPrevious`, `mergePreviousSlugs`,
 * `partitionResolved`) are NOT part of `Deps` — they're already directly testable and
 * already tested in `pure.test.ts`, so injecting them here would just be indirection.
 */
export interface Deps {
    findList: typeof findList;
    fetchUrl: typeof fetchUrl;
    extractCompetitors: typeof extractCompetitors;
    extractNames: typeof extractNames;
    isListPage: typeof isListPage;
    describeCandidates: typeof describeCandidates;
    readNames: typeof readNames;
    writeNames: typeof writeNames;
    readListPageVerdict: typeof readListPageVerdict;
    writeListPageVerdict: typeof writeListPageVerdict;
    loadPrevious: typeof loadPrevious;
    savePrevious: typeof savePrevious;
    pushData: (rows: OutputRow[]) => Promise<void>;
    charge: (event: { eventName: string; count: number }) => Promise<void>;
    /** Display cap, overridable only so tests can exercise the boundary without
     * generating 100+ fake candidates. Production always uses the default. */
    maxRows?: number;
}

const CONCURRENCY = 4;

/**
 * The whole pipeline: alternatives -> competitors -> own integrations -> peer and
 * directory source lists -> gap diff -> describe -> tag against the previous run ->
 * push -> charge. Everything that talks to the network, an LLM, or persisted state
 * goes through `deps`, so a caller (production `main.ts`, or a test) fully controls it.
 */
export async function runIntegrationRadar(input: Input, deps: Deps): Promise<RunSummary> {
    const { companyDomain } = input;
    // Defaults are applied by the schema, but an API caller can bypass it. `?? 20` rather
    // than a bare read, because `undefined` here silently turns comparisons into `false`
    // and produces a confident, empty "no gaps found" report.
    const maxCompetitors = input.maxCompetitors ?? 20;
    const minSources = input.minSources ?? 2;
    const directories = input.directories?.length ? input.directories : DEFAULT_DIRECTORIES;
    const MAX_ROWS = deps.maxRows ?? 100;

    /** Charges are accumulated and applied only after the dataset is pushed. */
    let freshSources = 0;
    const runDate = new Date().toISOString().slice(0, 10);

    log.info('Starting', { companyDomain, maxCompetitors, minSources, directories: directories.length });

    /**
     * Extract the names from a resolved page, reusing an earlier extraction when the page
     * record still holds one. This is what makes a restarted or migrated run cheap: the page
     * cache saves the fetch, this saves the LLM call that follows it.
     */
    async function namesFor(resolved: Resolved): Promise<string[]> {
        const cached = await deps.readNames(resolved.key);
        if (cached) {
            log.info('Names from cache', { url: resolved.hit!.url, count: cached.length });
            return cached;
        }
        const names = await deps.extractNames(resolved.hit!);
        if (names.length > 0) await deps.writeNames(resolved.key, names);
        return names;
    }

    /**
     * Gate search-tier hits through `isListPage`; leave path-tier hits alone.
     *
     * Not in the original brief — added after live testing. A site-scoped search returns
     * whatever ranks, and a vendor's own marketing page can pass every cheap heuristic
     * `web.ts` has: `zyte.com` resolved via search to `https://www.zyte.com/zyte-api/`, a
     * product page, which cleared every heuristic (long enough, keyword present, not an
     * article URL). Verified live: the gate correctly rejects it and correctly accepts
     * `apify.com/integrations` (95 names extracted).
     *
     * Path-tier hits skip the gate: they are deterministic and already pinned to the URL we
     * guessed (`https://{domain}{PATHS[kind]}`), so a call would only confirm what we
     * already know at the cost of an LLM round trip. See the doc comment on `Resolved.tier`
     * in `web.ts` — it describes which mechanism ran, not whether it succeeded, so `hit`
     * is always checked first.
     *
     * Fix round 1: the verdict is cached against the page record (`readListPageVerdict`/
     * `writeListPageVerdict`), so a page served from cache is gated once, not once per
     * run — see those functions' doc comments in `store.ts` for why re-gating unchanged
     * content on every run is a correctness risk, not just a cost one.
     */
    async function confirmed(resolved: Resolved, kind: ListKind): Promise<Resolved> {
        if (!resolved.hit || resolved.tier !== 'search') return resolved;

        const cachedVerdict = await deps.readListPageVerdict(resolved.key);
        const isList = cachedVerdict ?? (await deps.isListPage(resolved.hit, kind));
        if (cachedVerdict === null) await deps.writeListPageVerdict(resolved.key, isList);

        if (isList) return resolved;
        log.info('Rejected search hit — not a list page', { url: resolved.hit.url, kind });
        return { ...resolved, hit: null };
    }

    // 1. The company's own view of its competitive set.
    const alt = await confirmed(await deps.findList(companyDomain, 'alternatives'), 'alternatives');
    if (!alt.hit) {
        throw new Error(
            `No alternatives or comparison page found for ${companyDomain}. Many companies ` +
                'do not publish one; there is nothing to compare against.',
        );
    }
    const competitors = (await deps.extractCompetitors(alt.hit))
        .filter((c) => c.domain !== companyDomain)
        .slice(0, maxCompetitors);
    if (competitors.length === 0) throw new Error(`No usable competitors extracted from ${alt.hit.url}`);
    log.info('Competitors', { count: competitors.length });

    // 2. What the company already has. Without this the whole diff is meaningless,
    //    so a failure here is fatal rather than degraded.
    const own = await confirmed(await deps.findList(companyDomain, 'integrations'), 'integrations');
    if (!own.hit) throw new Error(`Could not read the integrations page for ${companyDomain}`);
    const mine = await namesFor(own);
    if (mine.length === 0) throw new Error(`Extracted no integrations from ${own.hit.url}`);
    if (!own.fromCache) freshSources += 1;
    log.info('Own integrations', { count: mine.length, url: own.hit.url });

    // 3. Build the candidate pool from both kinds of source, in parallel. `tierBySource`
    //    records which mechanism resolved each source (requirement: record which tier
    //    resolved each source) — used below to flag candidates whose only support is
    //    search-tier evidence, which is weaker than a deterministic path hit because a
    //    search result can resolve to a different URL on the next run (brightdata.com did,
    //    across two consecutive runs).
    const tierBySource = new Map<string, 'path' | 'search'>();

    const peerResults = await mapLimit(competitors, CONCURRENCY, async (competitor) => {
        const resolved = await confirmed(await deps.findList(competitor.domain, 'integrations'), 'integrations');
        if (!resolved.hit) return null;
        const names = await namesFor(resolved);
        if (names.length === 0) return null;
        if (!resolved.fromCache) freshSources += 1;
        if (resolved.tier) tierBySource.set(competitor.domain, resolved.tier);
        return { name: competitor.domain, kind: 'peer' as const, names };
    });

    const dirResults = await mapLimit(directories, CONCURRENCY, async (url) => {
        // fetchUrl only ever tries the path tier (see Resolved.tier's doc comment in
        // web.ts), so a fixed directory URL never needs the search-tier gate.
        const resolved = await deps.fetchUrl(url);
        if (!resolved.hit) return null;
        const names = await namesFor(resolved);
        if (names.length === 0) return null;
        if (!resolved.fromCache) freshSources += 1;
        const name = new URL(url).hostname;
        tierBySource.set(name, 'path');
        return { name, kind: 'directory' as const, names };
    });

    // `fullCoverage` is the input to the carry-forward rule below: whether *every*
    // competitor and directory resolved to a usable list this run. A single miss — a
    // thrown fetch, search flakiness, or the isListPage gate rejecting a bad hit — means
    // this run's candidate list is incomplete evidence, not proof that anything vanished.
    const peers = partitionResolved(peerResults);
    const dirs = partitionResolved(dirResults);
    const fullCoverage = peers.fullCoverage && dirs.fullCoverage;

    const sources: SourceList[] = [...peers.items, ...dirs.items];
    log.info('Sources read', { peers: peers.items.length, directories: dirs.items.length, fullCoverage });
    if (sources.length === 0) throw new Error('No source lists could be read.');

    // A coverage guard. If our own page yielded far less than the sources we compare
    // against, the diff is measuring page completeness rather than real gaps.
    const median = [...sources.map((s) => s.names.length)].sort((a, b) => a - b)[Math.floor(sources.length / 2)];
    if (mine.length < median * 0.4) {
        log.warning('Own list looks incomplete — treat results as low confidence', {
            mineCount: mine.length,
            medianSourceCount: median,
        });
    }

    // 4. The diff — plain code, no model involved. `fullGaps` is the complete ranked
    //    pool; `gaps` is what actually gets described and shown. Fix round 1 (critical):
    //    memory (`currentSlugs`, below) MUST be computed from `fullGaps`, not `gaps`.
    //    A candidate ranked #101 whose source resolved perfectly is still real evidence
    //    of "no change" — truncating it out of memory as well as out of the display
    //    reproduces the exact bug requirement 2 exists to prevent, just triggered by
    //    rank jitter around the cutoff instead of source failure: it would vanish from
    //    memory on a fullCoverage run, then read as spurious NEW the moment ordinary
    //    reordering pushed it back into the top MAX_ROWS. What we remember and what we
    //    display are two different things.
    const fullGaps = computeGaps(mine, sources, minSources);
    const gaps = fullGaps.slice(0, MAX_ROWS);
    log.info('Candidates', { count: gaps.length, totalRanked: fullGaps.length });

    // 5. Describe and tag against the previous run. `currentSlugs` comes from the full
    //    pool (see above), so `tags` covers every candidate that has real evidence this
    //    run, not just the ones that made the display cut.
    const described = await deps.describeCandidates(gaps);
    const previous = await deps.loadPrevious(companyDomain);
    const currentSlugs = fullGaps.map((g) => g.slug);
    const tags = diffAgainstPrevious(previous, currentSlugs);
    const isBaseline = previous.length === 0;

    const rows: OutputRow[] = gaps.map((gap) => ({
        ...gap,
        description: described.get(gap.slug)?.description ?? '',
        category: described.get(gap.slug)?.category ?? 'unknown',
        // On a first run everything is trivially new. Saying NEW would imply a competitor
        // just added it, which is not what happened.
        // `gap` is drawn from `gaps`, a slice of `fullGaps`, and `tags` was built from
        // every slug in `fullGaps` — so `gap.slug` is always a key in `tags` and the
        // non-null assertion is safe, not a hopeful one.
        status: isBaseline ? 'BASELINE' : tags.get(gap.slug)!,
        weakEvidence: gap.carriedBy.some((name) => tierBySource.get(name) === 'search'),
    }));

    // 6. Publish first, then charge. A charge before the push means the user can pay
    //    for a run that produced nothing.
    if (rows.length > 0) await deps.pushData(rows);

    // Carry-forward rule: never let a source (or a rank cutoff) that merely failed to
    // resolve/place this run read as "its integrations disappeared." When coverage is
    // incomplete, previously-known slugs are unioned into memory rather than replaced,
    // so a source that flakes out for one run and comes back does not get re-tagged
    // NEW. See mergePreviousSlugs in pure.ts.
    await deps.savePrevious(companyDomain, mergePreviousSlugs(previous, currentSlugs, fullCoverage), runDate);

    if (freshSources > 0) await deps.charge({ eventName: 'source-analyzed', count: freshSources });
    if (rows.length > 0) await deps.charge({ eventName: 'candidate-found', count: rows.length });

    return { rows, freshSources, fullCoverage, isBaseline, totalRanked: fullGaps.length };
}
