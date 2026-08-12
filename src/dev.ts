import { Actor, log } from 'apify';

import { extractCompetitors, extractNames } from './llm.js';
import { fetchUrl, findList } from './web.js';

// The SDK does NOT read .env — a bare `tsx` run has no token and every child
// call fails with "x402 payment header missing". `apify run` injects it; this
// scratch entrypoint has to do it itself.
process.loadEnvFile?.('.env');

await Actor.init();

const alt = await findList('apify.com', 'alternatives');
if (alt.hit) log.info('Competitors', await extractCompetitors(alt.hit));

const mine = await findList('apify.com', 'integrations');
if (mine.hit) log.info('Apify integrations', await extractNames(mine.hit));

const dir = await fetchUrl('https://n8n.io/integrations/');
if (dir.hit) log.info('Directory names', (await extractNames(dir.hit)).slice(0, 40));

await Actor.exit();
