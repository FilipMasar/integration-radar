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
    competitors?: string[];
}

export interface OutputRow extends Candidate {
    weakEvidence: boolean;
}

export interface RunSummary {
    rows: OutputRow[];
    freshSources: number;
    isBaseline: boolean;
    totalRanked: number;
    memoryReplaced: boolean;
    chargedEvents: number;
    chargingState: ChargeState;
}

// `inactive`: nothing billed and no limit hit, so not a budget event — the run is just not pay-per-event.
export type ChargeState = 'charged' | 'capped' | 'inactive' | 'none';

export interface ChargeOutcome {
    chargedCount: number;
    eventChargeLimitReached: boolean;
}

// Injected because importing `main.ts` runs `Actor.init()`, which would make the pipeline untestable.
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
    charge: (event: { eventName: string; count: number }) => Promise<ChargeOutcome>;
    maxRows?: number;
}

const CONCURRENCY = 4;
const DEFAULT_MAX_ROWS = 100;

const CHARGE_STATE_PRECEDENCE = ['capped', 'charged', 'inactive'] as const;

interface ResolvedInput {
    companyDomain: string;
    maxCompetitors: number;
    supplied: string[];
}

// The input schema binds the Console form, not an API caller. Both guards run before anything is
// fetched or charged, so a bad `maxCompetitors` cannot empty the competitor set at the cut below
// after the run has already paid for the company's own page.
function resolveInput(input: Input): ResolvedInput {
    const maxCompetitors = input.maxCompetitors ?? 20;
    if (!Number.isInteger(maxCompetitors) || maxCompetitors < 1) {
        throw new Error(`"maxCompetitors" must be an integer of at least 1, got ${maxCompetitors}.`);
    }
    if (input.competitors !== undefined && !Array.isArray(input.competitors)) {
        throw new Error('"competitors" must be an array of bare domains, such as ["rival.com"].');
    }

    return {
        companyDomain: input.companyDomain,
        maxCompetitors,
        supplied: input.competitors ?? [],
    };
}

async function chargeFor(
    deps: Deps,
    eventName: string,
    count: number,
): Promise<{ outcome: ChargeOutcome; state: ChargeState } | null> {
    if (count <= 0) return null;
    const outcome = await deps.charge({ eventName, count });

    if (outcome.chargedCount >= count) return { outcome, state: 'charged' };

    if (outcome.chargedCount === 0 && !outcome.eventChargeLimitReached) return { outcome, state: 'inactive' };

    log.warning('Charged fewer events than requested — a max-charge limit was reached', {
        eventName,
        requested: count,
        charged: outcome.chargedCount,
    });
    return { outcome, state: 'capped' };
}

async function namesFor(deps: Deps, resolved: Resolved): Promise<string[]> {
    const cached = await deps.readNames(resolved.key);
    if (cached) return cached;
    const names = await deps.extractNames(resolved.hit!);
    if (names.length > 0) await deps.writeNames(resolved.key, names);
    return names;
}

async function confirmed(deps: Deps, resolved: Resolved): Promise<Resolved> {
    if (!resolved.hit || resolved.tier !== 'search') return resolved;

    const cachedVerdict = await deps.readListPageVerdict(resolved.key);
    const isList = cachedVerdict ?? (await deps.isListPage(resolved.hit));
    if (cachedVerdict === null) await deps.writeListPageVerdict(resolved.key, isList);

    return isList ? resolved : { ...resolved, hit: null };
}

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
    if (discovered.length === 0) {
        throw new Error(
            `Could not determine competitors for ${companyDomain}. ` +
                'Pass them explicitly via the "competitors" input.',
        );
    }
    if (!cached) await deps.writeSeed(companyDomain, maxCompetitors, discovered);
    log.info('Competitors from seed', { count: discovered.length, fromCache: cached !== null });
    return discovered;
}

export async function runIntegrationRadar(input: Input, deps: Deps): Promise<RunSummary> {
    const { companyDomain, maxCompetitors, supplied } = resolveInput(input);
    const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;

    let freshSources = 0;
    const runDate = new Date().toISOString().slice(0, 10);

    log.info('Starting', { companyDomain, maxCompetitors });

    const discovered = await discoverCompetitors(deps, companyDomain, maxCompetitors, supplied);

    // Models name the subject among its own rivals often enough to matter: left in, the company's
    // own page would count as a competitor toward every candidate's `competitorCount`.
    const eligible = discovered.filter((c) => c.domain !== sourceName(companyDomain));
    if (eligible.length === 0) {
        throw new Error(`No competitors left for ${companyDomain} after excluding the company itself.`);
    }

    if (eligible.length > maxCompetitors) {
        log.warning('Competitor list truncated', { found: eligible.length, maxCompetitors });
    }

    const competitors = eligible.slice(0, maxCompetitors);

    const fingerprint = inputFingerprint({
        companyDomain,
        maxCompetitors,
        competitors: competitors.map((c) => c.domain),
    });

    const own = await confirmed(deps, await deps.findIntegrations(companyDomain));
    if (!own.hit) throw new Error(`Could not read the integrations page for ${companyDomain}`);
    const mine = await namesFor(deps, own);
    if (mine.length === 0) throw new Error(`Extracted no integrations from ${own.hit.url}`);
    if (!own.fromCache) freshSources += 1;
    log.info('Own integrations', { count: mine.length, url: own.hit.url });

    const tierBySource = new Map<string, 'path' | 'search'>();

    const results = await mapLimit(competitors, CONCURRENCY, async (competitor) => {
        try {
            const resolved = await confirmed(deps, await deps.findIntegrations(competitor.domain));
            if (!resolved.hit) {
                log.info('Competitor skipped — no integrations page', { domain: competitor.domain });
                return null;
            }
            const names = await namesFor(deps, resolved);
            if (names.length === 0) {
                log.info('Competitor skipped — nothing extracted', { domain: competitor.domain });
                return null;
            }
            if (!resolved.fromCache) freshSources += 1;
            log.info('Competitor read', {
                domain: competitor.domain,
                count: names.length,
                url: resolved.hit.url,
                via: resolved.tier,
            });
            const name = sourceName(competitor.domain);
            if (resolved.tier) tierBySource.set(name, resolved.tier);
            return { name, names };
        } catch (err) {
            // Store calls here are unguarded, and a throw would abort after paying for everything, before `pushData`.
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

    const median = sources.map((s) => s.names.length).sort((a, b) => a - b)[Math.floor(sources.length / 2)];
    if (mine.length < median * 0.4) {
        log.warning('Own list looks incomplete — treat results as low confidence', {
            mineCount: mine.length,
            medianSourceCount: median,
        });
    }

    const ranked = rankCandidates(mine, sources);
    const gaps = ranked.slice(0, maxRows);
    if (ranked.length > maxRows) log.warning('Candidate list truncated for display', { total: ranked.length, maxRows });
    log.info('Candidates', { count: gaps.length, totalRanked: ranked.length });

    const described = await deps.describeCandidates(gaps);
    const stored = await deps.loadPrevious(companyDomain);
    const previous: Memory = { slugs: stored?.slugs ?? [], sources: stored?.sources ?? [] };
    const current: Memory = { slugs: ranked.map((c) => c.slug), sources: sources.map((s) => s.name) };

    const inputsChanged = stored !== null && stored.fingerprint !== fingerprint;
    if (inputsChanged) {
        log.warning('Inputs changed since the last run — reporting a baseline, not a diff', {
            previousFingerprint: stored.fingerprint,
            fingerprint,
        });
    }

    const tags = diffAgainstPrevious(previous.slugs, current.slugs);
    const isBaseline = stored === null || previous.slugs.length === 0 || inputsChanged;

    const rows: OutputRow[] = gaps.map((gap) => {
        const d = described.get(gap.slug);
        return {
            ...gap,
            description: d?.description ?? '',
            category: d?.category ?? 'unknown',
            status: isBaseline ? 'BASELINE' : tags.get(gap.slug)!,
            weakEvidence: gap.carriedBy.some((name) => tierBySource.get(name) === 'search'),
        };
    });

    // Publish before charging, so a migration between the two cannot bill for rows nobody received.
    if (rows.length > 0) await deps.pushData(rows);

    const { memory, replaced: memoryReplaced } = mergeMemory(previous, current, inputsChanged);
    log.debug('Memory', {
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

    const states = charges.map((c) => c.state);
    const chargingState: ChargeState = CHARGE_STATE_PRECEDENCE.find((s) => states.includes(s)) ?? 'none';

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
