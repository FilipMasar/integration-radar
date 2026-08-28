import { log } from 'apify';

import type { describeCandidates, listIntegrations, seedCompetitors } from './llm.js';
import type { Candidate, Company, Memory, SourceList } from './pure.js';
import {
    diffAgainstPrevious,
    inputFingerprint,
    mapLimit,
    mergeMemory,
    normalizeCompetitors,
    ownNames,
    rankCandidates,
    sourceName,
} from './pure.js';
import type { loadPrevious, readIntegrations, readSeed, savePrevious, writeIntegrations, writeSeed } from './store.js';

export interface Input {
    companyDomain: string;
    maxCompetitors: number;
    competitors?: string[];
}

export type OutputRow = Candidate;

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

// Injected so the pipeline can be tested without the platform: the real ones open a key-value
// store and call an LLM.
export interface Deps {
    seedCompetitors: typeof seedCompetitors;
    listIntegrations: typeof listIntegrations;
    describeCandidates: typeof describeCandidates;
    readIntegrations: typeof readIntegrations;
    writeIntegrations: typeof writeIntegrations;
    readSeed: typeof readSeed;
    writeSeed: typeof writeSeed;
    loadPrevious: typeof loadPrevious;
    savePrevious: typeof savePrevious;
    pushData: (rows: OutputRow[]) => Promise<void>;
    charge: (event: { eventName: string; count: number }) => Promise<ChargeOutcome>;
    maxRows?: number;
}

const CONCURRENCY = 8;
const DEFAULT_MAX_ROWS = 100;

const CHARGE_STATE_PRECEDENCE = ['capped', 'charged', 'inactive'] as const;

interface ResolvedInput {
    companyDomain: string;
    maxCompetitors: number;
    supplied: string[];
}

// The platform validates input against the schema on every run, Console or API, but a local
// `apify run` does not. Both guards run before anything is looked up or charged.
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

async function integrationsFor(deps: Deps, domain: string): Promise<{ names: string[]; fromCache: boolean }> {
    const cached = await deps.readIntegrations(domain);
    if (cached?.length) return { names: cached, fromCache: true };

    const names = await deps.listIntegrations(domain);
    if (names.length > 0) await deps.writeIntegrations(domain, names);
    return { names, fromCache: false };
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
        log.info('Competitors from input', { count: discovered.length, domains: discovered.map((c) => c.domain) });
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
    // The whole result rests on this list, so name it rather than counting it.
    log.info('Competitors from seed', {
        count: discovered.length,
        fromCache: cached !== null,
        domains: discovered.map((c) => c.domain),
    });
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

    const own = await integrationsFor(deps, companyDomain);
    const mine = own.names;
    if (mine.length === 0) {
        throw new Error(
            `Could not list any integrations for ${companyDomain}. ` +
                'The model may not know this company well enough to compare it.',
        );
    }
    if (!own.fromCache) freshSources += 1;
    log.info('Own integrations', { count: mine.length, fromCache: own.fromCache });

    const results = await mapLimit(competitors, CONCURRENCY, async (competitor) => {
        try {
            const { names, fromCache } = await integrationsFor(deps, competitor.domain);
            if (names.length === 0) {
                log.info('Competitor skipped — no integrations known', { domain: competitor.domain });
                return null;
            }
            if (!fromCache) freshSources += 1;
            log.info('Competitor read', { domain: competitor.domain, count: names.length, fromCache });
            return { name: sourceName(competitor.domain), names };
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
    if (sources.length === 0) throw new Error('No integrations could be listed for any competitor.');

    const median = sources.map((s) => s.names.length).sort((a, b) => a - b)[Math.floor(sources.length / 2)];
    if (mine.length < median * 0.4) {
        log.warning('Own list looks incomplete — treat results as low confidence', {
            mineCount: mine.length,
            medianSourceCount: median,
        });
    }

    const ranked = rankCandidates([...mine, ...ownNames(companyDomain)], sources);
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
