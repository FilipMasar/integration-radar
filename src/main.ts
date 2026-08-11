import { Actor, log } from 'apify';

await Actor.init();

const input = await Actor.getInput<Record<string, unknown>>();
if (!input) throw new Error('Input is missing!');

log.info('Starting', { ...input });

await Actor.exit();
