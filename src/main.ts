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
import { findIntegrations } from './web.js';

await Actor.init();

// Exit promptly on abort rather than making more paid child-Actor and LLM calls after the
// user or the platform asked the run to stop.
Actor.on('aborting', async () => {
    await setTimeout(1000);
    await Actor.exit();
});

const input = await Actor.getInput<Input>();
if (!input) throw new Error('Input is missing!');

// Wiring only. The logic lives in `runIntegrationRadar`, which takes every external
// boundary as an injectable dependency — see its `Deps` doc comment.
const summary = await runIntegrationRadar(input, {
    findIntegrations,
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
    // The result is passed through, not swallowed: `chargedCount` can be lower than
    // requested once a max-charge limit is reached, and `chargeFor` checks it.
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
