import { log } from 'apify';

import type { describeCandidates, extractNames, isListPage, seedCompetitors } from './llm.js';
import type { Candidate, Company, Memory, SourceList } from './pure.js';
import {
    DEFAULT_DIRECTORIES,
    diffAgainstPrevious,
    inputFingerprint,
    mapLimit,
    mergeMemory,
    normalizeCompetitors,
    rankCandidates,
    sourceName,
} from './pure.js';
import type {
    loadPrevious,
    readListPageVerdict,
    readNames,
    readSeed,
    savePrevious,
    writeListPageVerdict,
    writeNames,
    writeSeed,
} from './store.js';
import type { fetchUrl, findIntegrations, Resolved } from './web.js';

export interface Input {
    companyDomain: string;
    maxCompetitors: number;
    directories: string[];
    minSources: number;
    /** Optional explicit competitor domains. When non-empty, discovery is skipped
     * entirely — no seed read, no LLM call. What joins the fingerprint is the set left
     * after the `maxCompetitors` cut, not this list verbatim — see the `fingerprint`
     * call site below. */
    competitors?: string[];
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
    isBaseline: boolean;
    totalRanked: number;
    /** True when memory superseded the stored one rather than being unioned into it. */
    memoryReplaced: boolean;
    /** Events actually billed, which can be fewer than requested — see `chargeFor`. */
    chargedEvents: number;
    /** What the platform did with this run's charges — see `ChargeState`. */
    chargingState: ChargeState;
}

/**
 * What the platform did with an accumulated charge.
 *
 * The three cases have to be told apart, because two of them look identical in
 * `chargedCount` alone and treating them the same produces a log line that contradicts
 * its own run summary:
 * - `charged`  — billed in full.
 * - `capped`   — billed in part, or refused, because a max-charge limit was reached.
 * - `inactive` — nothing billed and no limit reached, which is not a budget event at all:
 *   the run is simply not pay-per-event. The SDK no-ops `Actor.charge` on a non-PPE run
 *   and on a local run without `ACTOR_TEST_PAY_PER_EVENT=true`, returning
 *   `chargedCount: 0`. Reading that as "the user hit their limit" misattributes the
 *   cause, and on-platform that is a misleading operator signal.
 * - `none`     — no charge was attempted (nothing fresh, no rows).
 */
export type ChargeState = 'charged' | 'capped' | 'inactive' | 'none';

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
 * `inputFingerprint`) are NOT part of `Deps` — they're already directly testable and
 * already tested in `pure.test.ts`, so injecting them here would just be indirection.
 */
export interface Deps {
    findIntegrations: typeof findIntegrations;
    fetchUrl: typeof fetchUrl;
    seedCompetitors: typeof seedCompetitors;
    extractNames: typeof extractNames;
    isListPage: typeof isListPage;
    describeCandidates: typeof describeCandidates;
    readNames: typeof readNames;
    writeNames: typeof writeNames;
    readSeed: typeof readSeed;
    writeSeed: typeof writeSeed;
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
 * The whole pipeline: competitors -> own integrations -> peer and directory source
 * lists -> gap diff -> describe -> tag against the previous run -> push -> charge.
 * Everything that talks to the network, an LLM, or persisted state goes through `deps`,
 * so a caller (production `main.ts`, or a test) fully controls it.
 */
export async function runIntegrationRadar(input: Input, deps: Deps): Promise<RunSummary> {
    const { companyDomain } = input;
    // Defaults are applied by the schema, but an API caller can bypass it. `?? 20` rather
    // than a bare read, because `undefined` here silently turns comparisons into `false`
    // and produces a confident, empty "no gaps found" report.
    const maxCompetitors = input.maxCompetitors ?? 20;
    // Same reason as the default above — the schema's `type: integer, minimum: 1` binds the
    // Console form, not an API caller, and `0 ?? 20` is `0`. Rejected here rather than at
    // the cut in step 1, because by the time a bad value reaches `.slice` every fatal check
    // has already passed on a perfectly good competitor set: `slice(0, 0)` (or `slice(0,
    // NaN)`, which is why this tests for an integer and not just for `>= 1`) then empties
    // it, and the run goes on to read and *charge for* the company's own page and every
    // directory before producing the confident, empty report this whole block exists to
    // prevent. Naming the input is also the only way the error can name the actual cause.
    if (!Number.isInteger(maxCompetitors) || maxCompetitors < 1) {
        throw new Error(`"maxCompetitors" must be an integer of at least 1, got ${maxCompetitors}.`);
    }
    // Same standard as the guard above, and the same reason: the schema's `type: array`
    // binds the Console form, not an API caller. A bare string satisfies the
    // `supplied.length > 0` test in step 1 (strings have a length), so without this the run
    // dies inside `normalizeCompetitors` with `input.competitors.map is not a function`,
    // which names neither the input nor the mistake.
    if (input.competitors !== undefined && !Array.isArray(input.competitors)) {
        throw new Error('"competitors" must be an array of bare domains, such as ["rival.com"].');
    }
    const minSources = input.minSources ?? 2;
    const directories = input.directories?.length ? input.directories : DEFAULT_DIRECTORIES;
    const supplied = input.competitors ?? [];
    const MAX_ROWS = deps.maxRows ?? 100;

    /** Charges are accumulated and applied only after the dataset is pushed. */
    let freshSources = 0;
    const runDate = new Date().toISOString().slice(0, 10);

    log.info('Starting', { companyDomain, maxCompetitors, minSources, directories: directories.length });

    /**
     * Apply one accumulated charge and classify what the platform did with it.
     *
     * Apify's docs are explicit that with the `count` parameter `chargedCount` may come
     * back lower than requested once the user's max-total-charge limit is reached, and
     * that a caller using `count` must check it. There is nothing to undo at this point
     * — the rows are already pushed, deliberately, so a user can never pay for a run
     * that produced nothing — so the honest response is to say so rather than let an
     * under-charge pass silently.
     *
     * But an under-charge has two entirely different causes and only one of them is a
     * budget event. `eventChargeLimitReached` is the platform's own signal that the
     * limit was hit, and a partial (non-zero) charge is a cap by construction. A charge
     * of *zero* with no limit reported is neither: it is the SDK no-op on a run that is
     * not pay-per-event at all. Warning about a max-charge limit there both misstates
     * the cause and contradicts this run's own summary, which correctly reports no cap.
     */
    async function chargeFor(
        eventName: string,
        count: number,
    ): Promise<{ outcome: ChargeOutcome; state: ChargeState } | null> {
        if (count <= 0) return null;
        const outcome = await deps.charge({ eventName, count });

        if (outcome.chargedCount >= count) return { outcome, state: 'charged' };

        if (outcome.chargedCount === 0 && !outcome.eventChargeLimitReached) {
            log.info('Charging is not active for this run — nothing was billed', { eventName, requested: count });
            return { outcome, state: 'inactive' };
        }

        log.warning('Charged fewer events than requested — a max-charge limit was reached', {
            eventName,
            requested: count,
            charged: outcome.chargedCount,
        });
        return { outcome, state: 'capped' };
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
     * guessed (`https://{domain}{INTEGRATIONS_PATH}`), so a call would only confirm what we
     * already know at the cost of an LLM round trip. See the doc comment on `Resolved.tier`
     * in `web.ts` — it describes which mechanism ran, not whether it succeeded, so `hit`
     * is always checked first.
     *
     * Fix round 1: the verdict is cached against the page record (`readListPageVerdict`/
     * `writeListPageVerdict`), so a page served from cache is gated once, not once per
     * run — see those functions' doc comments in `store.ts` for why re-gating unchanged
     * content on every run is a correctness risk, not just a cost one.
     */
    async function confirmed(resolved: Resolved): Promise<Resolved> {
        if (!resolved.hit || resolved.tier !== 'search') return resolved;

        const cachedVerdict = await deps.readListPageVerdict(resolved.key);
        const isList = cachedVerdict ?? (await deps.isListPage(resolved.hit));
        if (cachedVerdict === null) await deps.writeListPageVerdict(resolved.key, isList);

        if (isList) return resolved;
        log.info('Rejected search hit — not a list page', { url: resolved.hit.url });
        return { ...resolved, hit: null };
    }

    // 1. The competitor set. Explicit input wins; otherwise a permanently-cached seed;
    //    otherwise one LLM call. This replaced reading the company's own /alternatives
    //    page, which was a fatal single point of failure that only worked where companies
    //    publish a multi-competitor comparison list — see the seed's doc comment in llm.ts.
    let discovered: Company[];

    if (supplied.length > 0) {
        discovered = normalizeCompetitors(supplied.map((d) => ({ name: d, domain: d })));
        const rejected = supplied.filter((d) => !discovered.some((c) => c.domain === sourceName(d)));
        if (rejected.length > 0) log.warning('Ignored competitor entries that are not bare domains', { rejected });
        if (discovered.length === 0) {
            throw new Error(
                `No usable competitor domains in the "competitors" input (rejected: ${supplied.join(', ')}). ` +
                    'Use bare domains such as "rival.com".',
            );
        }
        log.info('Competitors from input', { count: discovered.length });
    } else {
        const cached = await deps.readSeed(companyDomain, maxCompetitors);
        discovered = cached ?? (await deps.seedCompetitors(companyDomain, maxCompetitors));
        // `seedCompetitors` returns `[]` for all three of its failure modes — the LLM call
        // failing, the model naming nobody, every entry being unusable — and they are
        // deliberately indistinguishable here: none of them leaves anything to compare
        // against, and all three have the same remedy.
        if (discovered.length === 0) {
            throw new Error(
                `Could not determine competitors for ${companyDomain}. ` +
                    'Pass them explicitly via the "competitors" input.',
            );
        }
        // Stored raw, before the cut below: the record is keyed by `maxCompetitors`, so the
        // cut is re-applied identically on every read.
        if (!cached) await deps.writeSeed(companyDomain, maxCompetitors, discovered);
        log.info('Competitors from seed', { count: discovered.length, fromCache: cached !== null });
    }

    // The company itself is not a competitor to compare against: reading its own page as a
    // peer would let its own names carry a candidate toward `minSources`. Models name the
    // subject among its own rivals often enough to be worth the check. Compared without a
    // `sourceName` call on the left — every producer of `discovered` (both branches above)
    // runs `normalizeCompetitors`, so these domains are already normalized.
    const eligible = discovered.filter((c) => c.domain !== sourceName(companyDomain));
    if (eligible.length === 0) {
        throw new Error(`No competitors left for ${companyDomain} after excluding the company itself.`);
    }

    // Warned about *after* the self-exclusion, so the warning cannot fire on a run that
    // truncated nothing (a list of maxCompetitors + 1 whose extra entry is the company
    // itself loses nothing to the cut).
    if (eligible.length > maxCompetitors) {
        log.warning('Competitor list truncated', { found: eligible.length, maxCompetitors });
    }

    // No sort before the cut any more. The old alphabetical sort existed because `.slice`
    // on freshly-extracted model output was rank-cutoff-unstable between runs; the seed is
    // derived once and cached permanently, so the set no longer moves, and keeping the
    // model's order means the cut keeps the most direct competitors rather than the
    // alphabetically-first ones.
    const competitors = eligible.slice(0, maxCompetitors);

    // Identifies *what this run looks at*. Memory gathered under a different fingerprint
    // describes a different question and must not be diffed against — see
    // `inputFingerprint` and `mergeMemory` in pure.ts.
    //
    // Computed HERE, after the cut, from the competitor set actually read — not from
    // `input.competitors`. `inputFingerprint` sorts and dedupes what it is given, on the
    // principle that reordering the same list is not a different question. That is true
    // only while the list fits under `maxCompetitors`: past the cut, reordering decides
    // which entries survive it, so `['a.com','b.com','c.com']` and `['c.com','b.com',
    // 'a.com']` with `maxCompetitors: 2` open different pages under one fingerprint —
    // and every candidate carried only by the entry that swapped in is then reported
    // `NEW` with nothing having changed in the world. `mergeMemory` cannot rescue this;
    // limit #2 in its doc comment is exactly this case (it governs memory loss, not
    // gain). Sorting the supplied list before the cut would also fix it, but at the cost
    // of resurrecting the alphabetical cut this branch deliberately removed and of
    // discarding the priority order a user expressed in their own list.
    //
    // On the seeded path the effective set is the model's domains, which is stable
    // run-to-run precisely because the seed is cached permanently and the cut is
    // re-applied identically on every read — see `readSeed` in store.ts. If that ever
    // stops holding, this fingerprint changes every run and every run reports BASELINE.
    const fingerprint = inputFingerprint({
        companyDomain,
        maxCompetitors,
        directories,
        competitors: competitors.map((c) => c.domain),
    });

    // 2. What the company already has. Without this the whole diff is meaningless,
    //    so a failure here is fatal rather than degraded.
    const own = await confirmed(await deps.findIntegrations(companyDomain));
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
        const resolved = await confirmed(await deps.findIntegrations(competitor.domain));
        if (!resolved.hit) return null;
        const names = await namesFor(resolved);
        if (names.length === 0) return null;
        if (!resolved.fromCache) freshSources += 1;
        const name = sourceName(competitor.domain);
        if (resolved.tier) tierBySource.set(name, resolved.tier);
        return { name, kind: 'peer' as const, names };
    });
    const peers = peerResults.filter((r): r is NonNullable<typeof r> => r !== null);

    // Peer and directory names live in ONE namespace (`sourceName`), so a domain that is
    // both a competitor and a directory must not be read twice — `zapier.com` in both
    // roles used to yield `peerCount 1 + directoryCount 1 = 2` from a single page of
    // names, clearing the default `minSources: 2` on its own, and its directory pass
    // overwrote the peer's `'search'` tier in `tierBySource`, clearing `weakEvidence`.
    // The peer wins on a genuine collision: `peerCount` is the primary ranking key and
    // the competitor set is what the user actually asked about.
    //
    // Filtered against the peers that RESOLVED, not against the raw competitor list, and
    // therefore only after the peer pass has run. Filtering on the raw list turned this
    // dedup into a coverage regression for exactly the user class it was raised about:
    // for an automation platform, `zapier.com`, `make.com` and `pipedream.com` are all
    // likely competitors *and* three of the seven verified DEFAULT_DIRECTORIES. Each was
    // dropped before it was fetched and replaced by a competitor URL *guess*
    // (`https://zapier.com/integrations`, then a site-scoped search) rather than the
    // hand-verified directory URL this project measured — and if that guess resolved to
    // nothing, the source was lost outright rather than deduplicated. A directory whose
    // peer did not resolve is now still read, as a directory.
    const peerNames = new Set(peers.map((p) => p.name));
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

    const dirs = dirResults.filter((r): r is NonNullable<typeof r> => r !== null);

    const sources: SourceList[] = [...peers, ...dirs];
    log.info('Sources read', { peers: peers.length, directories: dirs.length });
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

    // 6. Publish first, then charge, so a migration between the two can never leave the
    //    user paying for rows they never received. Note the asymmetry this leaves, which
    //    is deliberate: `candidate-found` is guarded by `rows.length > 0`, but
    //    `source-analyzed` is charged for pages fetched fresh even on a run that produces
    //    zero rows. That is not "paying for nothing" — the pages were genuinely fetched
    //    and extracted, which is exactly what that event is advertised to bill for, and a
    //    zero-row run is a real answer ("no gaps found"), not a failure.
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

    const charges = [
        await chargeFor('source-analyzed', freshSources),
        await chargeFor('candidate-found', rows.length),
    ].filter((c) => c !== null);

    // Derived from the same classification the log lines use, so the summary and the log
    // can never disagree about whether this run hit a budget cap.
    const states = charges.map((c) => c.state);
    const chargingState: ChargeState = states.includes('capped')
        ? 'capped'
        : (states.find((s) => s !== 'inactive') ?? states[0] ?? 'none');

    return {
        rows,
        freshSources,
        isBaseline,
        totalRanked: fullGaps.length,
        memoryReplaced,
        chargedEvents: charges.reduce((sum, c) => sum + c.outcome.chargedCount, 0),
        chargingState,
    };
}
