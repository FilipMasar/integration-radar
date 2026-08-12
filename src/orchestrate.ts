import { log } from 'apify';

import type { describeCandidates, extractCompetitors, extractNames, isListPage } from './llm.js';
import type { Candidate, ListKind, Memory, SourceList } from './pure.js';
import {
    DEFAULT_DIRECTORIES,
    diffAgainstPrevious,
    inputFingerprint,
    mapLimit,
    mergeMemory,
    partitionResolved,
    rankCandidates,
    sourceName,
} from './pure.js';
import type {
    loadPrevious,
    readCompetitors,
    readListPageVerdict,
    readNames,
    savePrevious,
    writeCompetitors,
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
    /**
     * Whether every source this run *attempted* resolved. Observability only — a reader
     * seeing `false` knows the run was partially blind. It is no longer what decides
     * whether memory is replaced; see `mergeMemory` in `pure.ts`.
     */
    fullCoverage: boolean;
    isBaseline: boolean;
    totalRanked: number;
    /** True when memory superseded the stored one rather than being unioned into it. */
    memoryReplaced: boolean;
    /** Events actually billed, which can be fewer than requested — see `chargeFor`. */
    chargedEvents: number;
    /** True when the platform refused part of a charge because the run hit a budget cap. */
    chargeLimitReached: boolean;
}

/**
 * The parts of the Apify SDK's `ChargeResult` this pipeline acts on. Typed structurally
 * rather than imported so `orchestrate.ts` stays free of `apify` runtime imports (see the
 * `Deps` doc comment); `main.ts`'s wiring is what pins it to the real thing.
 */
export interface ChargeOutcome {
    chargedCount: number;
    eventChargeLimitReached: boolean;
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
 * Pure helpers (`mapLimit`, `rankCandidates`, `diffAgainstPrevious`, `mergeMemory`,
 * `inputFingerprint`, `partitionResolved`) are NOT part of `Deps` — they're already directly testable and
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
    readCompetitors: typeof readCompetitors;
    writeCompetitors: typeof writeCompetitors;
    readListPageVerdict: typeof readListPageVerdict;
    writeListPageVerdict: typeof writeListPageVerdict;
    loadPrevious: typeof loadPrevious;
    savePrevious: typeof savePrevious;
    pushData: (rows: OutputRow[]) => Promise<void>;
    /**
     * Returns the platform's answer, not `void`. A batched charge can be honoured only
     * in part once the user's `ACTOR_MAX_TOTAL_CHARGE_USD` is reached, and discarding
     * the result makes that silent — the run keeps every row and bills for fewer.
     */
    charge: (event: { eventName: string; count: number }) => Promise<ChargeOutcome>;
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

    // Identifies *what this run looks at*. Memory gathered under a different fingerprint
    // describes a different question and must not be diffed against — see
    // `inputFingerprint` and `mergeMemory` in pure.ts.
    const fingerprint = inputFingerprint({ companyDomain, maxCompetitors, directories });

    log.info('Starting', { companyDomain, maxCompetitors, minSources, directories: directories.length });

    /**
     * Apply one accumulated charge and report what the platform actually billed.
     *
     * Apify's docs are explicit that with the `count` parameter `chargedCount` may come
     * back lower than requested once the user's max-total-charge limit is reached, and
     * that a caller using `count` must check it. There is nothing to undo at this point
     * — the rows are already pushed, deliberately, so a user can never pay for a run
     * that produced nothing — so the honest response is to say so loudly rather than
     * let an under-charge pass silently.
     */
    async function chargeFor(eventName: string, count: number): Promise<ChargeOutcome | null> {
        if (count <= 0) return null;
        const result = await deps.charge({ eventName, count });
        if (result.chargedCount < count) {
            log.warning('Charged fewer events than requested — the run hit a max-charge limit', {
                eventName,
                requested: count,
                charged: result.chargedCount,
            });
        }
        return result;
    }

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
    // This page costs a child-Actor fetch plus a full LLM extraction exactly like every
    // other source, so it is charged like every other source. It used not to be, while
    // the company's own integrations page was — two mismatches with the advertised
    // event, in opposite directions.
    if (!alt.fromCache) freshSources += 1;

    // Cached against the alternatives page record, like every other extraction. Without
    // this an LLM re-derived the competitor set from a marketing page on every run, so
    // the source set the entire diff rests on was re-rolled each time — see
    // `readCompetitors` in store.ts.
    const cachedCompetitors = await deps.readCompetitors(alt.key);
    const extracted = cachedCompetitors ?? (await deps.extractCompetitors(alt.hit));
    if (!cachedCompetitors && extracted.length > 0) await deps.writeCompetitors(alt.key, extracted);

    const competitors = extracted
        // `sourceName` on both sides: `www.apify.com` on apify.com's own alternatives
        // page is the company itself, not a competitor to compare it against.
        .filter((c) => sourceName(c.domain) !== sourceName(companyDomain))
        // Sorted before the cut, so the selection depends on the *set* the model returned
        // and not on the order it happened to return it in. `.slice` on raw model output
        // is the same rank-cutoff bug already fixed one layer down for `MAX_ROWS`: a mere
        // reordering swapped which competitors were read, and a competitor that silently
        // left the set took its candidates out of the run's evidence with it.
        .sort((a, b) => sourceName(a.domain).localeCompare(sourceName(b.domain)))
        .slice(0, maxCompetitors);
    if (competitors.length === 0) throw new Error(`No usable competitors extracted from ${alt.hit.url}`);
    log.info('Competitors', { count: competitors.length, fromCache: cachedCompetitors !== null });

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

    // Peer and directory names live in ONE namespace (`sourceName`), so a domain that is
    // both a competitor and a directory must not be read twice — `zapier.com` in both
    // roles used to yield `peerCount 1 + directoryCount 1 = 2` from a single page of
    // names, clearing the default `minSources: 2` on its own, and its directory pass
    // overwrote the peer's `'search'` tier in `tierBySource`, clearing `weakEvidence`.
    // The peer wins: `peerCount` is the primary ranking key and the competitor set is
    // what the user actually asked about. Dropping the duplicate here rather than
    // deduping afterwards also saves the fetch.
    const peerNames = new Set(competitors.map((c) => sourceName(c.domain)));
    const effectiveDirectories = directories.filter((url) => {
        const name = sourceName(url);
        if (name === sourceName(companyDomain)) {
            log.info('Skipping directory — it is the company being analyzed', { url });
            return false;
        }
        if (peerNames.has(name)) {
            log.info('Skipping directory — already read as a competitor', { url });
            return false;
        }
        return true;
    });

    const peerResults = await mapLimit(competitors, CONCURRENCY, async (competitor) => {
        const resolved = await confirmed(await deps.findList(competitor.domain, 'integrations'), 'integrations');
        if (!resolved.hit) return null;
        const names = await namesFor(resolved);
        if (names.length === 0) return null;
        if (!resolved.fromCache) freshSources += 1;
        const name = sourceName(competitor.domain);
        if (resolved.tier) tierBySource.set(name, resolved.tier);
        return { name, kind: 'peer' as const, names };
    });

    const dirResults = await mapLimit(effectiveDirectories, CONCURRENCY, async (url) => {
        // fetchUrl only ever tries the path tier (see Resolved.tier's doc comment in
        // web.ts), so a fixed directory URL never needs the search-tier gate.
        const resolved = await deps.fetchUrl(url);
        if (!resolved.hit) return null;
        const names = await namesFor(resolved);
        if (names.length === 0) return null;
        if (!resolved.fromCache) freshSources += 1;
        const name = sourceName(url);
        tierBySource.set(name, 'path');
        return { name, kind: 'directory' as const, names };
    });

    // Whether *every* source this run attempted resolved to a usable list. Reported and
    // logged so a reader can see how blind the run was; it is NOT what decides whether
    // memory is replaced — the evidence-base comparison in `mergeMemory` is.
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

    // 4. The diff — plain code, no model involved. Three pools, and keeping them apart
    //    is the whole discipline: what we REMEMBER, what we RANK for display, and what we
    //    actually SHOW.
    //
    //    `ranked` is every candidate with any evidence at all. It is what goes into
    //    memory, because both narrowing steps below are presentation choices:
    //      - `minSources` is a noise knob the README tells users to turn. Filtering
    //        before memory means raising it to 3 and back to 2 makes every 2-source
    //        candidate return as fabricated NEW — the documented workflow producing the
    //        exact defect this Actor exists to avoid. It also means ordinary extraction
    //        jitter (a 2-source candidate whose second source omits it this run) erases
    //        the candidate from memory rather than merely hiding it.
    //      - `MAX_ROWS` is a display cap. A candidate ranked #101 whose source resolved
    //        perfectly is still real evidence of "no change"; truncating it out of memory
    //        makes rank jitter around the cutoff read as NEW.
    //    Same principle both times: what we remember and what we display are two
    //    different things.
    const ranked = rankCandidates(mine, sources);
    const fullGaps = ranked.filter((c) => c.peerCount + c.directoryCount >= minSources);
    const gaps = fullGaps.slice(0, MAX_ROWS);
    log.info('Candidates', { count: gaps.length, aboveThreshold: fullGaps.length, totalRanked: ranked.length });

    // 5. Describe and tag against the previous run.
    const described = await deps.describeCandidates(gaps);
    const stored = await deps.loadPrevious(companyDomain);
    const previous: Memory = { slugs: stored?.slugs ?? [], sources: stored?.sources ?? [] };
    const current: Memory = { slugs: ranked.map((c) => c.slug), sources: sources.map((s) => s.name) };

    // A stored record whose fingerprint does not match this run's was gathered under
    // different conditions — a different competitor cap, a different directory list, or
    // (for a record written before fingerprints existed) conditions we simply cannot
    // know. Diffing against it would report the change in the *question* as change in
    // the *world*. Report a baseline instead, and say so.
    const inputsChanged = stored !== null && stored.fingerprint !== fingerprint;
    if (inputsChanged) {
        log.warning('Inputs changed since the last run — reporting a baseline, not a diff', {
            previousFingerprint: stored.fingerprint,
            fingerprint,
        });
    }

    const tags = diffAgainstPrevious(previous.slugs, current.slugs);
    const isBaseline = stored === null || previous.slugs.length === 0 || inputsChanged;

    const rows: OutputRow[] = gaps.map((gap) => ({
        ...gap,
        description: described.get(gap.slug)?.description ?? '',
        category: described.get(gap.slug)?.category ?? 'unknown',
        // On a first run — or the first run after the inputs changed — everything is
        // trivially new. Saying NEW would imply a competitor just added it, which is not
        // what happened.
        // `gap` is drawn from `gaps`, a slice of a filter of `ranked`, and `tags` was
        // built from every slug in `ranked` — so `gap.slug` is always a key in `tags`
        // and the non-null assertion is safe, not a hopeful one.
        status: isBaseline ? 'BASELINE' : tags.get(gap.slug)!,
        weakEvidence: gap.carriedBy.some((name) => tierBySource.get(name) === 'search'),
    }));

    // 6. Publish first, then charge. A charge before the push means the user can pay
    //    for a run that produced nothing.
    if (rows.length > 0) await deps.pushData(rows);

    // Carry-forward rule: never let a source that merely failed to resolve this run —
    // or one this run never attempted — read as "its integrations disappeared." Memory
    // is superseded only when this run's evidence base covers everything the stored
    // memory rests on; otherwise it is unioned in. See mergeMemory in pure.ts.
    const { memory, replaced: memoryReplaced } = mergeMemory(previous, current, inputsChanged);
    log.info('Memory', {
        stored: memory.slugs.length,
        thisRun: current.slugs.length,
        replaced: memoryReplaced,
        sources: memory.sources.length,
    });
    await deps.savePrevious(companyDomain, { ...memory, fingerprint }, runDate);

    const sourceCharge = await chargeFor('source-analyzed', freshSources);
    const candidateCharge = await chargeFor('candidate-found', rows.length);

    return {
        rows,
        freshSources,
        fullCoverage,
        isBaseline,
        totalRanked: fullGaps.length,
        memoryReplaced,
        chargedEvents: (sourceCharge?.chargedCount ?? 0) + (candidateCharge?.chargedCount ?? 0),
        chargeLimitReached:
            (sourceCharge?.eventChargeLimitReached ?? false) || (candidateCharge?.eventChargeLimitReached ?? false),
    };
}
