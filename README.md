Integration Radar identifies a company's competitors — from the model's knowledge of its market, or from a list you supply — resolves each competitor's **integrations** page, and cross-references that against large public integration directories (n8n, Zapier, Make, Pipedream, LangChain, LlamaIndex, Smithery). It then reports every third-party product or service that shows up across multiple of those sources but is missing from the company's own integrations page — a competitive gap list, ranked by how many independent sources actually carry the name, not by opinion.

## What does Integration Radar do?

Integration Radar answers one question: **what integrations do my competitors and the wider ecosystem have that I don't?** Give it a company domain (for example `apify.com`) and it names that company's competitors automatically — or takes the list from you — reads what each of them integrates with, harvests names from the integration directories every automation platform and AI framework publishes, and diffs all of that against the company's own integrations page.

The result is a ranked dataset of missing integrations — with evidence. Every row shows exactly which pages it was found on, so you can open them and check for yourself rather than trusting a black-box score. Run it on demand from the Apify Console or API, schedule it to re-run weekly to catch newly-added competitor integrations, and pull the output straight into Sheets, Slack or a BI tool through Apify's built-in integrations.

## Why use Integration Radar?

- **Product and partnerships teams** get a data-backed starting point for "what should we integrate with next" instead of relying on sales anecdotes or a single competitor's homepage.
- **Competitive intelligence** teams can track, over repeated runs, which integrations a competitor set has added since the last check — the Actor tags each finding `NEW` or `SEEN` automatically.
- **Marketing and SEO** teams researching integration-landing-page content get a ready list of products the market already associates with this category.
- It replaces a manual process — opening a dozen competitor sites, skimming their integration pages, and cross-checking against Zapier/Make/n8n by hand — with one automated run.

## How to use Integration Radar

1. Open Integration Radar in the Apify Console (or call it via the API).
2. Enter the **Company domain** you want to analyze, as a bare domain such as `apify.com`. This is the only required input.
3. Optionally set **Competitors** explicitly if you'd rather not rely on automatic discovery, or adjust **Maximum competitors**, **Integration directories**, or **Minimum sources per candidate** (see [Input](#input) below). The defaults work well for a first run.
4. Start the run. It typically finishes in 3–6 minutes.
5. Open the **Output** tab (or fetch the dataset via the API) to see the ranked list of integrations your company is missing.
6. Re-run the same domain later — on a schedule, or manually — to see which findings are genuinely `NEW` since the last run rather than baseline noise.

## Input

Integration Radar takes one required field and four optional tuning knobs. See the **Input** tab for the full schema with defaults and validation.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `companyDomain` | string | Yes | — | The company to analyze, as a bare domain (e.g. `apify.com`). Its competitors are identified automatically from the model's knowledge of the market, or supplied via `competitors`. |
| `maxCompetitors` | integer | No | `20` | How many competitors to read. The competitor set is named most-direct-first, so a lower number keeps the closest competitors and drops the rest. Must be an integer of at least 1. |
| `competitors` | array of strings | No | `[]` | Explicit competitor domains. When set, these are used instead of asking the model to name competitors. Changing it resets the comparison. |
| `directories` | array of strings | No | 7 built-in directories (n8n, Zapier, Make, Pipedream, LangChain, LlamaIndex, Smithery) | Large integration directories to harvest names from. Override to target a different ecosystem. A directory that is also one of the discovered competitors is read once, not twice — as that competitor if its integrations page resolves, and as the directory otherwise. |
| `minSources` | integer | No | `2` | Only report a name carried by at least this many sources (competitors + directories combined). Raise it to cut noise. This filters the report only — every candidate found is remembered regardless, so turning this knob never fabricates a `NEW`. |

### Changing what the run reads resets the comparison

`NEW` means "no source we read last time carried this name." That claim is only honest if both runs looked at the same things, so the Actor records a fingerprint of `companyDomain`, `maxCompetitors`, `directories` and the competitor set alongside its memory. The competitor set in that fingerprint is the one the run actually reads — after the `maxCompetitors` cut, and whether you supplied it or the model named it — so anything that changes which pages get opened is caught, including reordering a `competitors` list longer than `maxCompetitors` and deleting the cached seed. When it changes, the next run reports `BASELINE` for every row instead of a diff, and resumes `NEW`/`SEEN` tagging from the run after that. `minSources` is exempt — it only filters the report, so you can turn it freely without losing your history.

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
  "carriedBy": ["browse.ai", "kadoa.com", "bardeen.ai", "n8n.io", "zapier.com", "make.com", "pipedream.com"],
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
| `carriedBy` | array | The competitor domains and directory hostnames where this name was found — open any of them to verify the finding. Normalized (no `www.`), so one site is one source however it was reached. |
| `description` | string | A short, factual, one-sentence description of what the product is. |
| `category` | string | A short category label (e.g. `crm`, `spreadsheet`, `web-scraping`). |
| `status` | string | `BASELINE` on a company's first run, and on the first run after `competitors`, `maxCompetitors`, or `directories` changed; otherwise `NEW` (no source read last time carried this name) or `SEEN` (it did). |
| `weakEvidence` | boolean | `true` if at least one contributing source was found via search rather than a deterministic URL guess (see [Limitations](#faq-limitations-and-support)). |

## Pricing / Cost estimation

Integration Radar is priced pay-per-event (PPE), not per compute unit. Two events are charged, each **$0.02**:

- **`source-analyzed`** — charged once per page fetched fresh this run and extracted: the company's own integrations page, each competitor's integrations page, and each directory. A page served from cache is free, and a page that fails to resolve is never charged.
- **`candidate-found`** — charged once per row written to the output dataset (capped at 100 rows).

### What a run is estimated to cost

These figures come from a live run of the shipped seed-based mechanism against
`apify.com` (`maxCompetitors: 20`, 7 directories). Of the 20 competitor domains the model
seeded, 7 resolved a usable integrations page, so the run read 15 sources in total: the
company's own page, those 7 competitor pages, and 7 directories. It produced 53 candidate
rows.

That run's page cache was already warm from earlier testing, so only 3 of the 15 sources
were actually fetched fresh and billed — the other 12 were free cache hits. The counts
below (15 sources, 53 rows) are measured; the cost is priced as a **cold** first run, where
all 15 sources are fetched fresh, since that is what a new user is actually budgeting for.

| | Count | Cost |
|---|---|---|
| `source-analyzed` (cold-run) | 15 — the own integrations page, 7 resolved competitor pages, and 7 directories | $0.30 |
| `candidate-found` | 53 rows | $1.06 |
| **Total** | **68 events** | **$1.36** |

Expect **$1.14–$1.56** for a comparable first run (12–18 fresh sources at $0.24–$0.36, plus 45–60 rows at $0.90–$1.20). Fewer than half of a typical competitor set publishes a findable integrations page (7 of 20 here), so the fresh-source count usually lands well below `maxCompetitors`.

What drives cost:

- **Number of competitors** (`maxCompetitors`) — more competitors means more pages to read, and more `source-analyzed` events on a cold run.
- **Cache warmth** — a page fetched on a previous run is served from cache and charges nothing under `source-analyzed`. A same-day re-run — confirmed in the live run above, which saw `freshSources: 0` on its second pass — drops the entire $0.30 `source-analyzed` line and costs just $1.06.
- **`minSources`** — raising it reduces the number of rows that clear the bar, which lowers `candidate-found` charges (and noise) together. This is the bigger lever of the two: rows outnumber sources roughly three to one.

Note that a warm re-run is cheaper but not dramatically so, because `candidate-found` is charged for every row on every run, not only for rows that changed.

## Tips and advanced options

- **Run it again to get real signal.** The first run for any domain is always `status: "BASELINE"` — there is nothing to compare against yet, so every row starts there rather than being falsely marked `NEW`. `NEW` and `SEEN` only become meaningful from the second run onward. Schedule periodic re-runs if you want ongoing change detection.
- **Raise `minSources` to cut noise.** The default of 2 favors recall. If the output includes names that feel like directory noise (see limitations below), raising `minSources` to 3 or 4 trades some coverage for higher-confidence rows.
- **Widen `maxCompetitors` for a more thorough sweep**, up to the input form's maximum of 30 — the model may know more direct competitors than the default keeps, and the cut respects its most-direct-first ordering, so a lower number already drops the least-relevant entries first, not arbitrary ones. (That 30 is a guard rail on the Console form, not a hard limit: an API caller can pass a larger value and the Actor will honour it. It costs one `source-analyzed` event per competitor page that actually resolves, so treat a big number as a cost decision.)
- **Point `directories` at a different ecosystem** if your company's competitors are not automation/AI-platform adjacent — pass your own list of large, well-maintained integration directories relevant to your space instead of the defaults.
- **Expect one `BASELINE` run whenever the set of pages read changes** — after editing `competitors`, `maxCompetitors` or `directories`, and equally after deleting the cached seed so a fresh competitor set is derived. See [Input](#input) — it is deliberate, and it is what stops a tuning change from being reported as competitor activity.
- **Check `weakEvidence` before treating a `NEW` row as confirmed.** A `true` value means at least one contributing source was resolved through a site-scoped search rather than a fixed URL guess, and search results can point to a different page on the next run.

## FAQ, limitations, and support

**Does a missing integration mean my competitor definitely doesn't have it?** No — it means it wasn't found in the sources this Actor reads. A source's presence measures what a company *publishes*, not what it actually supports.

**Why does the output include odd or irrelevant names?** A few reasons, by design tradeoff:
- **Not every competitor publishes an integrations page.** Some don't have one at all, or theirs is thin enough to fail extraction; those competitors simply contribute nothing to the diff, and there's no way around that short of the competitor publishing one.
- **"Integration" means different things on different sites.** Some pages list genuine third-party product integrations, others list partnership announcements, and at least one observed competitor's "integrations" page was really a set of proxy setup guides. The `category` field and `description` are there to help you sanity-check each row rather than take the name at face value.
- **Large directories include developer-tooling registries** (e.g. MCP-server listings), so runtime names like `Bun` or `Deno` can occasionally surface as "integrations" when they're really listed servers, not third-party product connectors. Raising `minSources` filters most of this out, since noise rarely clears more than one or two sources.
- **The underlying LLM extraction can occasionally hallucinate a name** that isn't really on a page. Nothing cross-checks this automatically — `carriedBy` is there so you can verify any row that looks off.

**Where do the competitors come from?** From the model's knowledge of your market, cached
permanently so the set cannot drift between runs, or from the `competitors` input if you
supply one. Earlier versions read the company's own "alternatives" page, which only works
in markets where companies publish one — of 22 mainstream SaaS domains tested, none did.
The trade-off to understand: the competitor set is a *starting point*, so a competitor the
model does not know about is simply never looked at, and this is mostly a coverage problem,
not an evidence one — every integration reported still comes from a page that was fetched
and is listed in `carriedBy`. It is only "mostly": if the model names a real company but
gets it slightly wrong (the wrong domain for a real competitor, say), that page still
resolves and its names still count toward `peerCount`, so a bad name from the model can feed
in a real but less-relevant peer, not just an outright fabrication. Because the cache never
expires, a competitor that starts competing with you *after* your first run never joins the
set on its own. To refresh the set: pass `competitors` explicitly, change `maxCompetitors`
(a different value seeds a fresh set under a new cache key), or open this Actor's
`integration-radar` key-value store in Apify Console and delete the `seed-...` key for your
domain, then re-run. If you know your competitors, passing them explicitly is the most
direct fix.

**Why is there no priority score or effort estimate?** Because the Actor has no way to know it honestly. It doesn't know your roadmap, your engineering capacity, or your existing partnerships — only `peerCount`, `directoryCount`, and `carriedBy`, which are evidence you can inspect, not a verdict.

**What does `weakEvidence: true` mean, and why does it exist?** Some competitor pages can't be found at a predictable URL and are instead located through a site-scoped search. Search results are less stable than a fixed URL — the same competitor's page can resolve on one run and fail to resolve on the next, even though nothing on their site changed. In the live run measured against `apify.com` (see [Pricing](#pricing--cost-estimation)), at least one resolved source — Bright Data's — was found only via a cached search hit rather than a fixed URL guess; that run did not separately track how many of its 53 rows carried `weakEvidence: true` as a result. To avoid false "this integration was removed" signals caused by nothing more than a flaky search result, the Actor never treats an unresolved source as evidence of removal: it records which sources its memory actually rests on, and only lets a candidate drop out on a run that read every one of them. `weakEvidence` flags exactly which rows rest on that less-stable kind of evidence so you can weigh them accordingly.

**Is scraping these pages legal?** Integration Radar only reads pages that companies have published publicly on the open web (their own and competitors' integrations pages and public integration directories) — no login, no paywalled content. You are responsible for using the output in line with the terms of the sites involved and applicable law in your jurisdiction.

**Something looks wrong, or I have a feature request.** Please open an issue on the Actor's Issues tab in Apify Console with the run ID and, if possible, the `companyDomain` you ran it against — that's enough to reproduce most problems. Custom variants of this Actor (different discovery logic, different directories, private integrations) can be discussed there too.
