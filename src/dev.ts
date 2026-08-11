import { Actor, log } from 'apify';
import { writeFileSync } from 'node:fs';

await Actor.init();
const client = Actor.newClient();

const run = await client.actor('apify/rag-web-browser').call(
    { query: 'https://apify.com/alternatives', maxResults: 1, outputFormats: ['markdown'], scrapingTool: 'raw-http' },
    { memory: 1024 },
);
const { items } = await client.dataset(run.defaultDatasetId).listItems();
const md = (items[0] as { markdown?: string })?.markdown ?? '';
writeFileSync('.superpowers/sdd/2026-08-11-integration-radar/task-2-alternatives.md', md);
log.info('alternatives fetched', { chars: md.length, status: run.status });

await Actor.exit();
