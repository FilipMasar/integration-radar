import { setTimeout } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { describeCandidates, extractNames, isListPage, seedCompetitors } from './llm.js';
import type { Input } from './orchestrate.js';
import { runIntegrationRadar } from './orchestrate.js';
import {
    loadPrevious,
    readListPageVerdict,
    readNames,
    readSeed,
    savePrevious,
    writeListPageVerdict,
    writeNames,
    writeSeed,
} from './store.js';
import { fetchUrl, findIntegrations } from './web.js';

await Actor.init();

// Handle the `aborting` event so a stopped/cancelled run exits promptly rather than
// continuing to make paid child-Actor and LLM calls after the user (or the platform)
// asked it to stop. Per this project's AGENTS.md.
Actor.on('aborting', async () => {
    await setTimeout(1000);
    await Actor.exit();
});

const input = await Actor.getInput<Input>();
if (!input) throw new Error('Input is missing!');

// All the actual logic lives in orchestrate.ts's runIntegrationRadar, which takes
// every external boundary as an injectable dependency — that's what makes it testable
// without a live Actor environment (see orchestrate.ts's Deps doc comment). This is
// wiring only: the real implementations, plus the two Actor methods that don't have a
// standalone equivalent outside this SDK.
const summary = await runIntegrationRadar(input, {
    findIntegrations,
    fetchUrl,
    seedCompetitors,
    extractNames,
    isListPage,
    describeCandidates,
    readNames,
    writeNames,
    readSeed,
    writeSeed,
    readListPageVerdict,
    writeListPageVerdict,
    loadPrevious,
    savePrevious,
    pushData: async (rows) => Actor.pushData(rows),
    // Passed through, not swallowed. `Actor.charge` returns a `ChargeResult` whose
    // `chargedCount` can be lower than the requested `count` once the user's
    // max-total-charge limit is reached; `runIntegrationRadar` checks it and warns.
    charge: async (event) => Actor.charge(event),
});

log.info('Done', {
    candidates: summary.rows.length,
    totalRanked: summary.totalRanked,
    new: summary.rows.filter((r) => r.status === 'NEW').length,
    baseline: summary.isBaseline,
    freshSources: summary.freshSources,
    memoryReplaced: summary.memoryReplaced,
    chargedEvents: summary.chargedEvents,
    chargingState: summary.chargingState,
});

await Actor.exit();
