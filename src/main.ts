import { Actor, log } from 'apify';

import { describeCandidates, listIntegrations, seedCompetitors } from './llm.js';
import type { Input } from './orchestrate.js';
import { runIntegrationRadar } from './orchestrate.js';
import { loadPrevious, readIntegrations, readSeed, savePrevious, writeIntegrations, writeSeed } from './store.js';

await Actor.init();

Actor.on('aborting', async () => {
    await Actor.exit();
});

const input = await Actor.getInput<Input>();
if (!input) throw new Error('Input is missing!');

try {
    const summary = await runIntegrationRadar(input, {
        seedCompetitors,
        listIntegrations,
        describeCandidates,
        readIntegrations,
        writeIntegrations,
        readSeed,
        writeSeed,
        loadPrevious,
        savePrevious,
        pushData: async (rows) => Actor.pushData(rows),
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
} catch (err) {
    // Without this the rejection reaches the top level, and the user's last log line is a Node
    // stack trace with an empty run status message.
    const { message } = err as Error;
    log.error(message);
    await Actor.fail(message);
}

await Actor.exit();
