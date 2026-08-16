import { log } from 'apify';

import type { describeCandidates, extractNames, isListPage, seedCompetitors } from './llm.js';
import type { Candidate, Company, Memory, SourceList } from './pure.js';
import {
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
import type { findIntegrations, Resolved } from './web.js';

export interface Input {
    companyDomain: string;
    maxCompetitors: number;
    /** Optional explicit competitor domains. When non-empty, discovery is skipped
     *  entirely — no seed read, no LLM call. */
    competitors?: string[];
}

/** A finished output row, `Candidate` plus the search-tier weak-evidence flag. */
export interface OutputRow extends Candidate {
    /**
     * True when a source carrying this candidate resolved via search rather than the
     * deterministic path guess. Search hits move between runs, so a NEW tag resting on
     * one deserves extra scrutiny rather than equal confidence.
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
    chargingState: ChargeState;
}

/**
 * What the platform did with an accumulated charge. Two of these look identical in
 * `chargedCount` alone, and conflating them produces a log line that contradicts the run
 * summary:
 * - `charged`  — billed in full.
 * - `capped`   — billed in part, or refused, because a max-charge limit was reached.
 * - `inactive` — nothing billed and no limit reached, so not a budget event at all: the
 *   run is simply not pay-per-event, and the SDK no-ops `Actor.charge`.
 * - `none`     — no charge attempted (nothing fresh, no rows).
 */
export type ChargeState = 'charged' | 'capped' | 'inactive' | 'none';

/**
 * The parts of the SDK's `ChargeResult` this pipeline acts on. Typed structurally rather
 * than imported so this module stays free of `apify` runtime imports; `main.ts` pins it
 * to the real thing.
 */
export interface ChargeOutcome {
    chargedCount: number;
    eventChargeLimitReached: boolean;
}

/**
 * Every external boundary the pipeline touches, as injectable functions.
 *
 * This module exists so `runIntegrationRadar` is importable with no side effects:
 * `main.ts`'s top level calls `Actor.init()` and `Actor.getInput()` on import alone,
 * which would make the pipeline untestable. A test builds a fake `Deps` and calls it
 * directly — no module mocking, no live Actor environment.
 *
 * Pure helpers are not part of `Deps`: they are already directly testable, so injecting
 * them would only add indirection.
 */
export interface Deps {
    findIntegrations: typeof findIntegrations;
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
     * Returns the platform's answer, not `void`. A batched charge can be honoured only in
     * part once `ACTOR_MAX_TOTAL_CHARGE_USD` is reached, and discarding the result makes
     * that silent — the run keeps every row and bills for fewer.
     */
    charge: (event: { eventName: string; count: number }) => Promise<ChargeOutcome>;
    /** Display cap, overridable only so tests can exercise the boundary without
     *  generating 100+ fake candidates. Production always uses the default. */
    maxRows?: number;
}

const CONCURRENCY = 4;
const DEFAULT_MAX_ROWS = 100;

interface ResolvedInput {
    companyDomain: string;
    maxCompetitors: number;
    supplied: string[];
}

/**
 * Apply defaults and reject inputs the schema cannot catch — it binds the Console form,
 * not an API caller.
 *
 * Both guards run before anything is fetched or charged. `maxCompetitors` is checked here
 * rather than at the cut because by then every fatal check has passed on a perfectly good
 * competitor set: `slice(0, 0)` — or `slice(0, NaN)`, hence the integer test — empties it,
 * and the run reads and charges for the company's own page before producing the confident,
 * empty report this exists to prevent.
 */
function resolveInput(input: Input): ResolvedInput {
    // `?? 20` rather than a bare read: `undefined` silently turns every comparison false.
    const maxCompetitors = input.maxCompetitors ?? 20;
    if (!Number.isInteger(maxCompetitors) || maxCompetitors < 1) {
        throw new Error(`"maxCompetitors" must be an integer of at least 1, got ${maxCompetitors}.`);
    }
    // A bare string has a `length`, so it would pass the "supplied?" test and die deeper
    // down with "supplied.map is not a function", naming neither the input nor the mistake.
    if (input.competitors !== undefined && !Array.isArray(input.competitors)) {
        throw new Error('"competitors" must be an array of bare domains, such as ["rival.com"].');
    }

    return {
        companyDomain: input.companyDomain,
        maxCompetitors,
        supplied: input.competitors ?? [],
    };
}

/**
 * Apply one accumulated charge and classify what the platform did with it.
 *
 * With a `count` parameter `chargedCount` can come back lower than requested once the
 * user's max-charge limit is reached, and a caller using `count` must check it. There is
 * nothing to undo — rows are pushed first, deliberately — so the honest response is to say
 * so rather than let an under-charge pass silently. A charge of *zero* with no limit
 * reported is a different thing entirely: the SDK no-op on a non-PPE run.
 */
async function chargeFor(
    deps: Deps,
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
 * record still holds one. The page cache saves the fetch; this saves the LLM call after it.
 */
async function namesFor(deps: Deps, resolved: Resolved): Promise<string[]> {
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
 * A site-scoped search returns whatever ranks, and a vendor's marketing page can pass
 * every cheap heuristic `web.ts` has — `zyte.com/zyte-api/` did. Path hits skip the gate:
 * they are deterministic and already pinned to the URL we guessed, so a call would only
 * confirm what we know. `hit` is checked first because `tier` reports which mechanism ran,
 * not whether it succeeded.
 *
 * The verdict is cached against the page record, so a cached page is gated once rather
 * than once per run — see `readListPageVerdict` for why re-gating unchanged content is a
 * correctness risk, not just a cost one.
 */
async function confirmed(deps: Deps, resolved: Resolved): Promise<Resolved> {
    if (!resolved.hit || resolved.tier !== 'search') return resolved;

    const cachedVerdict = await deps.readListPageVerdict(resolved.key);
    const isList = cachedVerdict ?? (await deps.isListPage(resolved.hit));
    if (cachedVerdict === null) await deps.writeListPageVerdict(resolved.key, isList);

    if (isList) return resolved;
    log.info('Rejected search hit — not a list page', { url: resolved.hit.url });
    return { ...resolved, hit: null };
}

/**
 * The competitor set: explicit input wins, otherwise a permanently-cached seed, otherwise
 * one LLM call. This replaced reading the company's own `/alternatives` page, which was a
 * fatal single point of failure wherever companies do not publish one.
 */
async function discoverCompetitors(
    deps: Deps,
    companyDomain: string,
    maxCompetitors: number,
    supplied: string[],
): Promise<Company[]> {
    if (supplied.length > 0) {
        const discovered = normalizeCompetitors(supplied.map((d) => ({ name: d, domain: d })));
        const rejected = supplied.filter((d) => !discovered.some((c) => c.domain === sourceName(d)));
        if (rejected.length > 0) log.warning('Ignored competitor entries that are not bare domains', { rejected });
        if (discovered.length === 0) {
            throw new Error(
                `No usable competitor domains in the "competitors" input (rejected: ${supplied.join(', ')}). ` +
                    'Use bare domains such as "rival.com".',
            );
        }
        log.info('Competitors from input', { count: discovered.length });
        return discovered;
    }

    const cached = await deps.readSeed(companyDomain, maxCompetitors);
    const discovered = cached ?? (await deps.seedCompetitors(companyDomain, maxCompetitors));
    // `seedCompetitors` returns `[]` for all three of its failure modes — the call failed,
    // the model named nobody, every entry was unusable — and they are indistinguishable
    // here on purpose: none leaves anything to compare against, and all three have the
    // same remedy.
    if (discovered.length === 0) {
        throw new Error(
            `Could not determine competitors for ${companyDomain}. ` +
                'Pass them explicitly via the "competitors" input.',
        );
    }
    // Stored before the cut below: the record is keyed by `maxCompetitors`, so the cut is
    // re-applied identically on every read.
    if (!cached) await deps.writeSeed(companyDomain, maxCompetitors, discovered);
    log.info('Competitors from seed', { count: discovered.length, fromCache: cached !== null });
    return discovered;
}

/**
 * The whole pipeline: competitors -> own integrations -> each competitor's integrations
 * -> gap diff -> describe -> tag against the previous run -> push -> charge. Everything
 * that touches the network, an LLM, or persisted state goes through `deps`.
 */
export async function runIntegrationRadar(input: Input, deps: Deps): Promise<RunSummary> {
    const { companyDomain, maxCompetitors, supplied } = resolveInput(input);
    const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;

    /** Charges are accumulated and applied only after the dataset is pushed. */
    let freshSources = 0;
    const runDate = new Date().toISOString().slice(0, 10);

    log.info('Starting', { companyDomain, maxCompetitors });

    // 1. The competitor set.
    const discovered = await discoverCompetitors(deps, companyDomain, maxCompetitors, supplied);

    // The company is not a competitor to compare against: reading its own page as a peer
    // would let its own names count toward a candidate's `competitorCount`. Models name the
    // subject among its own rivals often enough to be worth the check. No `sourceName`
    // call on the left — `normalizeCompetitors` has already normalized these.
    const eligible = discovered.filter((c) => c.domain !== sourceName(companyDomain));
    if (eligible.length === 0) {
        throw new Error(`No competitors left for ${companyDomain} after excluding the company itself.`);
    }

    // Warned after the self-exclusion, so a list of maxCompetitors + 1 whose extra entry is
    // the company itself does not report a truncation that never happened.
    if (eligible.length > maxCompetitors) {
        log.warning('Competitor list truncated', { found: eligible.length, maxCompetitors });
    }

    // No sort before the cut: the seed is derived once and cached, so the set no longer
    // moves between runs, and keeping the model's order means the cut keeps the most
    // direct competitors rather than the alphabetically-first ones.
    const competitors = eligible.slice(0, maxCompetitors);

    // Computed here, after the cut, from the set actually read — not from
    // `input.competitors`. `inputFingerprint` sorts what it is given, which is only safe
    // once the cut has happened: past the cut, order decides which entries survive, so
    // `['a','b','c']` and `['c','b','a']` with `maxCompetitors: 2` would open different
    // pages under one fingerprint and report every difference as `NEW`. Sorting before the
    // cut would also fix that, at the cost of resurrecting the alphabetical cut this
    // design removed and discarding the priority order a user expressed.
    const fingerprint = inputFingerprint({
        companyDomain,
        maxCompetitors,
        competitors: competitors.map((c) => c.domain),
    });

    // 2. What the company already has. Without this the diff is meaningless, so failure
    //    here is fatal rather than degraded.
    const own = await confirmed(deps, await deps.findIntegrations(companyDomain));
    if (!own.hit) throw new Error(`Could not read the integrations page for ${companyDomain}`);
    const mine = await namesFor(deps, own);
    if (mine.length === 0) throw new Error(`Extracted no integrations from ${own.hit.url}`);
    if (!own.fromCache) freshSources += 1;
    log.info('Own integrations', { count: mine.length, url: own.hit.url });

    // 3. Read every competitor's integrations page, in parallel. `tierBySource` records
    //    which mechanism resolved each one, so candidates supported only by search-tier
    //    evidence can be flagged.
    const tierBySource = new Map<string, 'path' | 'search'>();

    const results = await mapLimit(competitors, CONCURRENCY, async (competitor) => {
        try {
            const resolved = await confirmed(deps, await deps.findIntegrations(competitor.domain));
            if (!resolved.hit) return null;
            const names = await namesFor(deps, resolved);
            if (names.length === 0) return null;
            if (!resolved.fromCache) freshSources += 1;
            const name = sourceName(competitor.domain);
            if (resolved.tier) tierBySource.set(name, resolved.tier);
            return { name, names };
        } catch (err) {
            // One competitor is not the run. The fetch and LLM layers already swallow their
            // own errors, but every store call here is unguarded, so a single 500 from the
            // key-value API would reject `mapLimit` and abort a run that has already paid
            // for the seed, the company's own page, and every competitor read so far —
            // crucially *before* `pushData`, so the user pays for all of it and gets nothing.
            //
            // Returning null instead routes this into the path already built for it:
            // downstream, an unresolved source is absent from `sources`, and `mergeMemory`'s
            // carry-forward rule keeps its candidates in memory so the next successful run
            // does not tag them NEW. A throw bypasses that machinery entirely; the same
            // real-world event deserves the same handling either way.
            log.warning('Competitor failed — skipping it, not the run', {
                domain: competitor.domain,
                error: (err as Error).message,
            });
            return null;
        }
    });

    const sources: SourceList[] = results.filter((r): r is NonNullable<typeof r> => r !== null);
    log.info('Competitors read', { resolved: sources.length, of: competitors.length });
    if (sources.length === 0) throw new Error('No competitor integrations pages could be read.');

    // If our own page yielded far less than the sources we compare against, the diff is
    // measuring page completeness rather than real gaps.
    const median = [...sources.map((s) => s.names.length)].sort((a, b) => a - b)[Math.floor(sources.length / 2)];
    if (mine.length < median * 0.4) {
        log.warning('Own list looks incomplete — treat results as low confidence', {
            mineCount: mine.length,
            medianSourceCount: median,
        });
    }

    // 4. The diff — plain code, no model involved. Everything a competitor carries and the
    //    company does not is reported; there is no evidence threshold. `ranked` is what
    //    goes into memory, not `gaps`: `maxRows` is a display cap, and truncating before
    //    memory would make rank jitter around the cutoff read as NEW.
    const ranked = rankCandidates(mine, sources);
    const gaps = ranked.slice(0, maxRows);
    if (ranked.length > maxRows) log.warning('Candidate list truncated for display', { total: ranked.length, maxRows });
    log.info('Candidates', { count: gaps.length, totalRanked: ranked.length });

    // 5. Describe and tag against the previous run.
    const described = await deps.describeCandidates(gaps);
    const stored = await deps.loadPrevious(companyDomain);
    const previous: Memory = { slugs: stored?.slugs ?? [], sources: stored?.sources ?? [] };
    const current: Memory = { slugs: ranked.map((c) => c.slug), sources: sources.map((s) => s.name) };

    // A stored record whose fingerprint does not match was gathered under different
    // conditions, or — with no fingerprint at all — under conditions we cannot know.
    // Diffing against it would report a change in the question as a change in the world.
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
        // On a baseline everything is trivially new; saying NEW would imply a competitor
        // just added it. `tags` was built from every slug in `ranked` and `gap` comes from
        // a slice of `ranked`, so the assertion is safe rather than hopeful.
        status: isBaseline ? 'BASELINE' : tags.get(gap.slug)!,
        weakEvidence: gap.carriedBy.some((name) => tierBySource.get(name) === 'search'),
    }));

    // 6. Publish first, then charge, so a migration between the two can never leave the
    //    user paying for rows they never received. The asymmetry is deliberate:
    //    `source-analyzed` bills for pages fetched fresh even on a zero-row run, because
    //    those pages were genuinely read and "no gaps found" is a real answer.
    if (rows.length > 0) await deps.pushData(rows);

    const { memory, replaced: memoryReplaced } = mergeMemory(previous, current, inputsChanged);
    log.info('Memory', {
        stored: memory.slugs.length,
        thisRun: current.slugs.length,
        replaced: memoryReplaced,
        sources: memory.sources.length,
    });
    await deps.savePrevious(companyDomain, { ...memory, fingerprint }, runDate);

    const charges = [
        await chargeFor(deps, 'source-analyzed', freshSources),
        await chargeFor(deps, 'candidate-found', rows.length),
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
        totalRanked: ranked.length,
        memoryReplaced,
        chargedEvents: charges.reduce((sum, c) => sum + c.outcome.chargedCount, 0),
        chargingState,
    };
}
