import { setTimeout } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { describeCandidates, extractCompetitors, extractNames, isListPage } from './llm.js';
import type { Candidate, ListKind, SourceList } from './pure.js';
import { computeGaps, DEFAULT_DIRECTORIES, diffAgainstPrevious, mapLimit, mergePreviousSlugs, partitionResolved } from './pure.js';
import { loadPrevious, readNames, savePrevious, writeNames } from './store.js';
import type { Resolved } from './web.js';
import { fetchUrl, findList } from './web.js';

await Actor.init();

// Handle the `aborting` event so a stopped/cancelled run exits promptly rather than
// continuing to make paid child-Actor and LLM calls after the user (or the platform)
// asked it to stop. Per this project's AGENTS.md.
Actor.on('aborting', async () => {
    await setTimeout(1000);
    await Actor.exit();
});

interface Input {
    companyDomain: string;
    maxCompetitors: number;
    directories: string[];
    minSources: number;
}

const input = await Actor.getInput<Input>();
if (!input) throw new Error('Input is missing!');

const { companyDomain } = input;
// Defaults are applied by the schema, but an API caller can bypass it. `?? 20` rather
// than a bare read, because `undefined` here silently turns comparisons into `false`
// and produces a confident, empty "no gaps found" report.
const maxCompetitors = input.maxCompetitors ?? 20;
const minSources = input.minSources ?? 2;
const directories = input.directories?.length ? input.directories : DEFAULT_DIRECTORIES;

/** Charges are accumulated and applied only after the dataset is pushed. */
let freshSources = 0;
const runDate = new Date().toISOString().slice(0, 10);
const MAX_ROWS = 100;
const CONCURRENCY = 4;

log.info('Starting', { companyDomain, maxCompetitors, minSources, directories: directories.length });

/**
 * Extract the names from a resolved page, reusing an earlier extraction when the page
 * record still holds one. This is what makes a restarted or migrated run cheap: the page
 * cache saves the fetch, this saves the LLM call that follows it.
 */
async function namesFor(resolved: Resolved): Promise<string[]> {
    const cached = await readNames(resolved.key);
    if (cached) {
        log.info('Names from cache', { url: resolved.hit!.url, count: cached.length });
        return cached;
    }
    const names = await extractNames(resolved.hit!);
    if (names.length > 0) await writeNames(resolved.key, names);
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
 */
async function confirmed(resolved: Resolved, kind: ListKind): Promise<Resolved> {
    if (!resolved.hit || resolved.tier !== 'search') return resolved;
    if (await isListPage(resolved.hit, kind)) return resolved;
    log.info('Rejected search hit — not a list page', { url: resolved.hit.url, kind });
    return { ...resolved, hit: null };
}

// 1. The company's own view of its competitive set.
const alt = await confirmed(await findList(companyDomain, 'alternatives'), 'alternatives');
if (!alt.hit) {
    throw new Error(
        `No alternatives or comparison page found for ${companyDomain}. Many companies ` +
            'do not publish one; there is nothing to compare against.',
    );
}
const competitors = (await extractCompetitors(alt.hit))
    .filter((c) => c.domain !== companyDomain)
    .slice(0, maxCompetitors);
if (competitors.length === 0) throw new Error(`No usable competitors extracted from ${alt.hit.url}`);
log.info('Competitors', { count: competitors.length });

// 2. What the company already has. Without this the whole diff is meaningless,
//    so a failure here is fatal rather than degraded.
const own = await confirmed(await findList(companyDomain, 'integrations'), 'integrations');
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
    const resolved = await confirmed(await findList(competitor.domain, 'integrations'), 'integrations');
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
    const resolved = await fetchUrl(url);
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
const median = [...sources.map((s) => s.names.length)].sort((a, b) => a - b)[
    Math.floor(sources.length / 2)
];
if (mine.length < median * 0.4) {
    log.warning('Own list looks incomplete — treat results as low confidence', {
        mineCount: mine.length,
        medianSourceCount: median,
    });
}

// 4. The diff — plain code, no model involved.
const gaps = computeGaps(mine, sources, minSources).slice(0, MAX_ROWS);
log.info('Candidates', { count: gaps.length });

// 5. Describe and tag against the previous run.
const described = await describeCandidates(gaps);
const previous = await loadPrevious(companyDomain);
const currentSlugs = gaps.map((g) => g.slug);
const tags = diffAgainstPrevious(previous, currentSlugs);
const isBaseline = previous.length === 0;

const rows: (Candidate & {
    /**
     * True when at least one source carrying this candidate resolved via the search
     * tier rather than a deterministic path guess. Search hits are not stable run to
     * run, so a NEW tag resting on search-tier evidence deserves a reader's extra
     * scrutiny rather than the same confidence as a path-hit-backed one.
     */
    weakEvidence: boolean;
})[] = gaps.map((gap) => ({
    ...gap,
    description: described.get(gap.slug)?.description ?? '',
    category: described.get(gap.slug)?.category ?? 'unknown',
    // On a first run everything is trivially new. Saying NEW would imply a competitor
    // just added it, which is not what happened.
    status: isBaseline ? 'BASELINE' : (tags.get(gap.slug) ?? 'NEW'),
    weakEvidence: gap.carriedBy.some((name) => tierBySource.get(name) === 'search'),
}));

// 6. Publish first, then charge. A charge before the push means the user can pay
//    for a run that produced nothing.
if (rows.length > 0) await Actor.pushData(rows);

// Carry-forward rule: never let a source that merely failed to resolve this run read
// as "its integrations disappeared." When coverage is incomplete, previously-known
// slugs are unioned into memory rather than replaced, so a source that flakes out for
// one run and comes back does not get re-tagged NEW. See mergePreviousSlugs in pure.ts.
await savePrevious(companyDomain, mergePreviousSlugs(previous, currentSlugs, fullCoverage), runDate);

if (freshSources > 0) await Actor.charge({ eventName: 'source-analyzed', count: freshSources });
if (rows.length > 0) await Actor.charge({ eventName: 'candidate-found', count: rows.length });

log.info('Done', {
    candidates: rows.length,
    new: rows.filter((r) => r.status === 'NEW').length,
    baseline: isBaseline,
    freshSources,
    fullCoverage,
});

await Actor.exit();
