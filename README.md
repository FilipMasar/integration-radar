Integration Radar reads a company's own **alternatives** page to find its competitors, resolves each competitor's **integrations** page, and cross-references that against large public integration directories (n8n, Zapier, Make, Pipedream, LangChain, LlamaIndex, Smithery). It then reports every third-party product or service that shows up across multiple of those sources but is missing from the company's own integrations page — a competitive gap list, ranked by how many independent sources actually carry the name, not by opinion.

## What does Integration Radar do?

Integration Radar answers one question: **what integrations do my competitors and the wider ecosystem have that I don't?** Give it a company domain (for example `apify.com`) and it discovers that company's competitors automatically, reads what each of them integrates with, harvests names from the integration directories every automation platform and AI framework publishes, and diffs all of that against the company's own integrations page.

The result is a ranked dataset of missing integrations — with evidence. Every row shows exactly which pages it was found on, so you can open them and check for yourself rather than trusting a black-box score. Run it on demand from the Apify Console or API, schedule it to re-run weekly to catch newly-added competitor integrations, and pull the output straight into Sheets, Slack or a BI tool through Apify's built-in integrations.

## Why use Integration Radar?

- **Product and partnerships teams** get a data-backed starting point for "what should we integrate with next" instead of relying on sales anecdotes or a single competitor's homepage.
- **Competitive intelligence** teams can track, over repeated runs, which integrations a competitor set has added since the last check — the Actor tags each finding `NEW` or `SEEN` automatically.
- **Marketing and SEO** teams researching integration-landing-page content get a ready list of products the market already associates with this category.
- It replaces a manual process — opening a dozen competitor sites, skimming their integration pages, and cross-checking against Zapier/Make/n8n by hand — with one automated run.

## How to use Integration Radar

1. Open Integration Radar in the Apify Console (or call it via the API).
2. Enter the **Company domain** you want to analyze, as a bare domain such as `apify.com`. This is the only required input.
3. Optionally adjust **Maximum competitors**, **Integration directories**, or **Minimum sources per candidate** (see [Input](#input) below). The defaults work well for a first run.
4. Start the run. It typically finishes in 3–6 minutes.
5. Open the **Output** tab (or fetch the dataset via the API) to see the ranked list of integrations your company is missing.
6. Re-run the same domain later — on a schedule, or manually — to see which findings are genuinely `NEW` since the last run rather than baseline noise.

## Input

Integration Radar takes one required field and three optional tuning knobs. See the **Input** tab for the full schema with defaults and validation.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `companyDomain` | string | Yes | — | The company to analyze, as a bare domain (e.g. `apify.com`). Its competitors are read from its own alternatives page. |
| `maxCompetitors` | integer | No | `20` | How many competitors to read. Alternatives pages are ordered by search volume, not relevance, so a low number tends to select the *least* relevant companies — 20 is a sensible floor. |
| `directories` | array of strings | No | 7 built-in directories (n8n, Zapier, Make, Pipedream, LangChain, LlamaIndex, Smithery) | Large integration directories to harvest names from. Override to target a different ecosystem. |
| `minSources` | integer | No | `2` | Only report a name carried by at least this many sources (competitors + directories combined). Raise it to cut noise. |

Example input:

```json
{
  "companyDomain": "apify.com",
  "maxCompetitors": 20,
  "minSources": 2
}
```

## Output

Each dataset row is one candidate integration your company doesn't (yet) have. You can download the dataset in various formats such as JSON, HTML, CSV, or Excel from the **Output** tab or via the API.

A real row from a run against `apify.com`:

```json
{
  "candidate": "Google Sheets",
  "slug": "google-sheets",
  "peerCount": 3,
  "directoryCount": 4,
  "carriedBy": ["browse.ai", "kadoa.com", "bardeen.ai", "n8n.io", "zapier.com", "www.make.com", "pipedream.com"],
  "description": "Cloud-based spreadsheet application for data organization and collaboration.",
  "category": "spreadsheet",
  "status": "BASELINE",
  "weakEvidence": true
}
```

### Ranking is by evidence, not by score

Rows are sorted by `peerCount` — the number of distinct **competitors** that carry the name — then by `directoryCount`. There is no composite score and no priority/effort estimate. That is a deliberate choice: the Actor has no visibility into your roadmap, engineering capacity, or existing integration partnerships, so it would have no honest basis for telling you what's "worth doing." What it can do, and does, is show its work: `carriedBy` lists exactly which competitor and directory pages contributed to a finding, so you can open them and verify the claim yourself instead of trusting an opaque number.

## Data table

| Field | Type | Description |
|---|---|---|
| `candidate` | string | The integration or product name, as extracted from its source pages. |
| `slug` | string | Normalized form of `candidate` used to deduplicate spelling variants (e.g. "AWS S3" and "Amazon S3" collapse to the same slug). |
| `peerCount` | number | How many distinct **competitors** carry this name on their integrations page. Primary ranking key. |
| `directoryCount` | number | How many of the integration directories (n8n, Zapier, Make, etc.) carry this name. Secondary ranking key. |
| `carriedBy` | array | The competitor domains and directory hostnames where this name was found — open any of them to verify the finding. |
| `description` | string | A short, factual, one-sentence description of what the product is. |
| `category` | string | A short category label (e.g. `crm`, `spreadsheet`, `web-scraping`). |
| `status` | string | `BASELINE` on a company's first run, otherwise `NEW` (not present in the previous run) or `SEEN` (present before). |
| `weakEvidence` | boolean | `true` if at least one contributing source was found via search rather than a deterministic URL guess (see [Limitations](#faq-limitations-and-support)). |

## Pricing / Cost estimation

Integration Radar is priced pay-per-event (PPE), not per compute unit. Two events are charged, each **$0.02**:

- **`source-analyzed`** — charged once per competitor or directory page that had to be fetched and extracted fresh this run (a page served from cache is free).
- **`candidate-found`** — charged once per row written to the output dataset (capped at 100 rows).

On a typical first run against a mid-sized domain (~20 competitors, 7 directories), expect roughly 25–30 fresh sources and 40–60 candidate rows, putting the charged total in the neighborhood of **$0.50–$2.50**. What drives cost:

- **Number of competitors** (`maxCompetitors`) — more competitors means more pages to read, and more `source-analyzed` events on a cold run.
- **Cache warmth** — a page fetched on a previous run is served from cache and charges nothing under `source-analyzed`. A re-run against the same domain a few days later is dramatically cheaper than the first run, since most competitor and directory pages haven't changed.
- **`minSources`** — raising it reduces the number of rows that clear the bar, which lowers `candidate-found` charges (and noise) together.

The first run for a given domain is always the most expensive one; re-running the same domain later to check for change costs a fraction of that, because most sources come straight from cache.

## Tips and advanced options

- **Run it again to get real signal.** The first run for any domain is always `status: "BASELINE"` — there is nothing to compare against yet, so every row starts there rather than being falsely marked `NEW`. `NEW` and `SEEN` only become meaningful from the second run onward. Schedule periodic re-runs if you want ongoing change detection.
- **Raise `minSources` to cut noise.** The default of 2 favors recall. If the output includes names that feel like directory noise (see limitations below), raising `minSources` to 3 or 4 trades some coverage for higher-confidence rows.
- **Widen `maxCompetitors` for a more thorough sweep**, up to the 30 maximum — alternatives pages tend to be ordered by search volume rather than relevance, so genuinely comparable competitors can sit further down the list.
- **Point `directories` at a different ecosystem** if your company's competitors are not automation/AI-platform adjacent — pass your own list of large, well-maintained integration directories relevant to your space instead of the defaults.
- **Check `weakEvidence` before treating a `NEW` row as confirmed.** A `true` value means at least one contributing source was resolved through a site-scoped search rather than a fixed URL guess, and search results can point to a different page on the next run.

## FAQ, limitations, and support

**Does a missing integration mean my competitor definitely doesn't have it?** No — it means it wasn't found in the sources this Actor reads. A source's presence measures what a company *publishes*, not what it actually supports.

**Why does the output include odd or irrelevant names?** A few reasons, by design tradeoff:
- **Not every competitor publishes an integrations page.** Some don't have one at all, or theirs is thin enough to fail extraction; those competitors simply contribute nothing to the diff, and there's no way around that short of the competitor publishing one.
- **"Integration" means different things on different sites.** Some pages list genuine third-party product integrations, others list partnership announcements, and at least one observed competitor's "integrations" page was really a set of proxy setup guides. The `category` field and `description` are there to help you sanity-check each row rather than take the name at face value.
- **Large directories include developer-tooling registries** (e.g. MCP-server listings), so runtime names like `Bun` or `Deno` can occasionally surface as "integrations" when they're really listed servers, not third-party product connectors. Raising `minSources` filters most of this out, since noise rarely clears more than one or two sources.
- **The underlying LLM extraction can occasionally hallucinate a name** that isn't really on a page. Nothing cross-checks this automatically — `carriedBy` is there so you can verify any row that looks off.

**Why is there no priority score or effort estimate?** Because the Actor has no way to know it honestly. It doesn't know your roadmap, your engineering capacity, or your existing partnerships — only `peerCount`, `directoryCount`, and `carriedBy`, which are evidence you can inspect, not a verdict.

**What does `weakEvidence: true` mean, and why does it exist?** Some competitor pages can't be found at a predictable URL and are instead located through a site-scoped search. Search results are less stable than a fixed URL — the same competitor's page can resolve on one run and fail to resolve on the next, even though nothing on their site changed. In the sample run this affected about 11% of rows. To avoid false "this integration was removed" signals caused by nothing more than a flaky search result, the Actor never treats an unresolved source as evidence of removal — it carries the previous run's known integrations forward instead of dropping them. `weakEvidence` flags exactly which rows rest on that less-stable kind of evidence so you can weigh them accordingly.

**Is scraping these pages legal?** Integration Radar only reads pages that companies have published publicly on the open web (their own alternatives/integrations pages and public integration directories) — no login, no paywalled content. You are responsible for using the output in line with the terms of the sites involved and applicable law in your jurisdiction.

**Something looks wrong, or I have a feature request.** Please open an issue on the Actor's Issues tab in Apify Console with the run ID and, if possible, the `companyDomain` you ran it against — that's enough to reproduce most problems. Custom variants of this Actor (different discovery logic, different directories, private integrations) can be discussed there too.
