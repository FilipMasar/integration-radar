import { Actor, log } from 'apify';
import { findList } from './web.js';

// The SDK does NOT read .env — a bare `tsx` run has no token and every child
// call fails with "x402 payment header missing". `apify run` injects it; this
// scratch entrypoint has to do it itself.
process.loadEnvFile?.('.env');

await Actor.init();

for (const domain of ['apify.com', 'firecrawl.dev', 'zyte.com', 'brightdata.com']) {
    const { hit, fromCache } = await findList(domain, 'integrations');
    log.info('==>', { domain, url: hit?.url ?? 'NOT FOUND', chars: hit?.markdown.length, fromCache });
}

await Actor.exit();
