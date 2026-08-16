Integration Radar identifies a company's competitors — from the model's knowledge of its market, or from a list you supply — resolves each competitor's **integrations** page, and reports every third-party product or service they carry that is missing from the company's own integrations page. A competitive gap list, ranked by how many competitors actually carry each name, not by opinion.

## What does Integration Radar do?

Integration Radar answers one question: **what do my competitors integrate with that I don't?** Give it a company domain (for example `apify.com`) and it names that company's competitors automatically — or takes the list from you — reads what each of them integrates with, and diffs all of it against the company's own integrations page.

The result is a ranked dataset of missing integrations — with evidence. Every row shows exactly which competitor pages it was found on, so you can open them and check for yourself rather than trusting a black-box score. Run it on demand from the Apify Console or API, schedule it to re-run weekly to catch newly-added competitor integrations, and pull the output straight into Sheets, Slack or a BI tool through Apify's built-in integrations.

## Why use Integration Radar?

- **Product and partnerships teams** get a data-backed starting point for "what should we integrate with next" instead of relying on sales anecdotes or a single competitor's homepage.
- **Competitive intelligence** teams can track, over repeated runs, which integrations a competitor set has added since the last check — the Actor tags each finding `NEW` or `SEEN` automatically.
- **Marketing and SEO** teams researching integration-landing-page content get a ready list of products the market already associates with this category.
- It replaces a manual process — opening a dozen competitor sites and skimming their integration pages by hand — with one automated run.

## How to use Integration Radar

1. Open Integration Radar in the Apify Console (or call it via the API).
2. Enter the **Company domain** you want to analyze, as a bare domain such as `apify.com`. This is the only required input.
3. Optionally set **Competitors** explicitly if you'd rather not rely on automatic discovery, or adjust **Maximum competitors**. The defaults work well for a first run.
4. Start the run. It typically finishes in 3–5 minutes.
5. Open the **Output** tab (or fetch the dataset via the API) to see the ranked list of integrations your company is missing.
6. Re-run the same domain later — on a schedule, or manually — to see which findings are genuinely `NEW` since the last run rather than baseline noise.

## Input

One required field and two optional ones. See the **Input** tab for the full schema with defaults and validation.

| Field            | Type             | Required | Default | Description                                                                                                                                                                        |
| ---------------- | ---------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companyDomain`  | string           | Yes      | —       | The company to analyze, as a bare domain (e.g. `apify.com`). Its competitors are identified automatically from the model's knowledge of the market, or supplied via `competitors`. |
| `maxCompetitors` | integer          | No       | `20`    | How many competitors to read. The competitor set is named most-direct-first, so a lower number keeps the closest competitors and drops the rest. Must be an integer of at least 1. |
| `competitors`    | array of strings | No       | `[]`    | Explicit competitor domains, as bare domains such as `rival.com`. When set, these are used instead of asking the model to name competitors.                                        |

### Changing what the run reads resets the comparison

`NEW` means "no competitor we read last time carried this name." That claim is only honest if both runs looked at the same pages, so the Actor records a fingerprint of `companyDomain`, `maxCompetitors` and the competitor set alongside its memory. The competitor set in that fingerprint is the one the run actually reads — after the `maxCompetitors` cut, and whether you supplied it or the model named it — so anything that changes which pages get opened is caught, including reordering a `competitors` list longer than `maxCompetitors` and deleting the cached seed. When it changes, the next run reports `BASELINE` for every row instead of a diff, and resumes `NEW`/`SEEN` tagging from the run after that.

Example input:

```json
{
    "companyDomain": "apify.com",
    "maxCompetitors": 20
}
```

## Output

Each dataset row is one candidate integration your company doesn't (yet) have. You can download the dataset in various formats such as JSON, HTML, CSV, or Excel from the **Output** tab or via the API.

```json
{
    "candidate": "Google Sheets",
    "slug": "google-sheets",
    "competitorCount": 4,
    "carriedBy": ["browse.ai", "axiom.ai", "simplescraper.io", "agenty.com"],
    "description": "Cloud-based spreadsheet application for creating and editing tabular data.",
    "category": "spreadsheet",
    "status": "BASELINE",
    "weakEvidence": false
}
```

### Ranking is by evidence, not by score

Rows are sorted by `competitorCount` — the number of distinct competitors that carry the name — with ties broken alphabetically so the order is stable between runs. There is no composite score and no priority/effort estimate. That is a deliberate choice: the Actor has no visibility into your roadmap, engineering capacity, or existing integration partnerships, so it would have no honest basis for telling you what's "worth doing." What it can do, and does, is show its work: `carriedBy` lists exactly which competitor pages contributed to a finding, so you can open them and verify the claim yourself instead of trusting an opaque number.

**There is no evidence threshold.** A name carried by a single competitor is reported, because one rival having something is worth knowing. It also means single-competitor rows are where extraction noise concentrates — read `competitorCount` as the confidence signal it is, and treat the top of the list as the strongest evidence.

## Data table

| Field             | Type    | Description                                                                                                                                                                                      |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `candidate`       | string  | The integration or product name, as extracted from its source pages.                                                                                                                             |
| `slug`            | string  | Normalized form of `candidate` used to deduplicate spelling variants (e.g. "AWS S3" and "Amazon S3" collapse to the same slug).                                                                  |
| `competitorCount` | number  | How many distinct competitors carry this name on their integrations page. The ranking key.                                                                                                       |
| `carriedBy`       | array   | The competitor domains where this name was found — open any of them to verify the finding. Normalized (no `www.`), so one site is one source however it was reached.                             |
| `description`     | string  | A short, factual, one-sentence description of what the product is.                                                                                                                               |
| `category`        | string  | A short category label (e.g. `crm`, `spreadsheet`, `web-scraping`).                                                                                                                              |
| `status`          | string  | `BASELINE` on a company's first run, and on the first run after `competitors` or `maxCompetitors` changed; otherwise `NEW` (no competitor read last time carried this name) or `SEEN` (one did). |
| `weakEvidence`    | boolean | `true` if at least one contributing competitor page was found via search rather than a deterministic URL guess (see [Limitations](#faq-limitations-and-support)).                                |

## Pricing / Cost estimation

Integration Radar is priced pay-per-event (PPE), not per compute unit. Two events are charged, each **$0.02**:

- **`source-analyzed`** — charged once per integrations page fetched fresh this run and extracted: the company's own, and each competitor's. A page served from cache is free, and a page that fails to resolve is never charged.
- **`candidate-found`** — charged once per row written to the output dataset (capped at 100 rows).

### What a run is estimated to cost

**Source count is measured; row count is an estimate.** A live run against `apify.com` with `maxCompetitors: 20` resolved a usable integrations page for **10 of the 20** competitors the model named, so it read **11 sources**: the company's own page plus those 10. That figure predates the removal of the directory pass and is unaffected by it.

The row count has not yet been measured in this configuration. Those 10 competitor pages yielded 144 extracted names between them; after removing what `apify.com` already has, deduplicating spelling variants and dropping generic stopwords, expect roughly **60–90 rows**.

|                              | Count                                               | Cost             |
| ---------------------------- | --------------------------------------------------- | ---------------- |
| `source-analyzed` (cold run) | 11 — the own page plus 10 resolved competitor pages | $0.22            |
| `candidate-found`            | ~60–90 rows                                         | $1.20–$1.80      |
| **Total**                    |                                                     | **≈$1.42–$2.02** |

Fewer than half of a typical competitor set publishes a findable integrations page (10 of 20 here), so the fresh-source count usually lands well below `maxCompetitors`.

What drives cost:

- **Number of rows.** This dominates — rows outnumber sources roughly six to one, so `candidate-found` is most of the bill. With no evidence threshold, every gap found is a row.
- **Number of competitors** (`maxCompetitors`) — more competitors means more pages to read, and more `source-analyzed` events on a cold run.
- **Cache warmth** — a page fetched on a previous run is served from cache and charges nothing under `source-analyzed`. A same-day re-run drops the entire `source-analyzed` line.

Note that a warm re-run is cheaper but not dramatically so, because `candidate-found` is charged for every row on every run, not only for rows that changed.

## Tips and advanced options

- **Run it again to get real signal.** The first run for any domain is always `status: "BASELINE"` — there is nothing to compare against yet, so every row starts there rather than being falsely marked `NEW`. `NEW` and `SEEN` only become meaningful from the second run onward. Schedule periodic re-runs if you want ongoing change detection.
- **Read `competitorCount` as the confidence column.** With no threshold, everything found is reported. Sorting is already by this field, so the strongest evidence is at the top; scan down until the rows stop looking useful.
- **Widen `maxCompetitors` for a more thorough sweep**, up to the input form's maximum of 30 — the model may know more direct competitors than the default keeps, and the cut respects its most-direct-first ordering, so a lower number already drops the least-relevant entries first, not arbitrary ones. (That 30 is a guard rail on the Console form, not a hard limit: an API caller can pass a larger value and the Actor will honour it. It costs one `source-analyzed` event per competitor page that actually resolves, so treat a big number as a cost decision.)
- **Pass `competitors` explicitly when you know your market better than a model does.** It skips discovery entirely, costs nothing extra, and gives you exact control over what the run compares against.
- **Expect one `BASELINE` run whenever the set of pages read changes** — after editing `competitors` or `maxCompetitors`, and equally after deleting the cached seed so a fresh competitor set is derived. It is deliberate, and it is what stops a tuning change from being reported as competitor activity.
- **Check `weakEvidence` before treating a `NEW` row as confirmed.** A `true` value means at least one contributing source was resolved through a site-scoped search rather than a fixed URL guess, and search results can point to a different page on the next run.

## FAQ, limitations, and support

**Does a missing integration mean my competitor definitely doesn't have it?** No — it means it wasn't found on the pages this Actor reads. An integrations page measures what a company _publishes_, not what it actually supports.

**Why does the output include odd or irrelevant names?** A few reasons, by design tradeoff:

- **Not every competitor publishes an integrations page.** Some don't have one at all, or theirs is thin enough to fail extraction; those competitors simply contribute nothing to the diff, and there's no way around that short of the competitor publishing one.
- **"Integration" means different things on different sites.** Some pages list genuine third-party product integrations, others list partnership announcements, and at least one observed competitor's "integrations" page was really a set of proxy setup guides. The `category` and `description` fields are there to help you sanity-check each row rather than take the name at face value.
- **There is no evidence threshold**, so a name mentioned by exactly one competitor is reported alongside one carried by five. `competitorCount` is how you tell them apart.
- **The underlying LLM extraction can occasionally hallucinate a name** that isn't really on a page. Nothing cross-checks this automatically — `carriedBy` is there so you can verify any row that looks off.

**Where do the competitors come from?** From the model's knowledge of your market, cached permanently so the set cannot drift between runs, or from the `competitors` input if you supply one. Earlier versions read the company's own "alternatives" page, which only works in markets where companies publish one — of 22 mainstream SaaS domains tested, none did. The trade-off to understand: the competitor set is a _starting point_, so a competitor the model does not know about is simply never looked at, and this is mostly a coverage problem, not an evidence one — every integration reported still comes from a page that was fetched and is listed in `carriedBy`. It is only "mostly": if the model names a real company but gets it slightly wrong (the wrong domain for a real competitor, say), that page still resolves and its names still count toward `competitorCount`, so a bad name from the model can feed in a real but less-relevant peer, not just an outright fabrication. Because the cache never expires, a competitor that starts competing with you _after_ your first run never joins the set on its own. To refresh the set: pass `competitors` explicitly, change `maxCompetitors` (a different value seeds a fresh set under a new cache key), or open this Actor's `integration-radar` key-value store in Apify Console and delete the `seed-...` key for your domain, then re-run. If you know your competitors, passing them explicitly is the most direct fix.

**Why is there no priority score or effort estimate?** Because the Actor has no way to know it honestly. It doesn't know your roadmap, your engineering capacity, or your existing partnerships — only `competitorCount` and `carriedBy`, which are evidence you can inspect, not a verdict.

**What does `weakEvidence: true` mean, and why does it exist?** Some competitor pages can't be found at a predictable URL and are instead located through a site-scoped search. Search results are less stable than a fixed URL — the same competitor's page can resolve on one run and fail to resolve on the next, even though nothing on their site changed. To avoid false "this integration was removed" signals caused by nothing more than a flaky search result, the Actor never treats an unresolved source as evidence of removal: it records which sources its memory actually rests on, and only lets a candidate drop out on a run that read every one of them. `weakEvidence` flags exactly which rows rest on that less-stable kind of evidence so you can weigh them accordingly.

**Is scraping these pages legal?** Integration Radar only reads pages that companies have published publicly on the open web — their own and their competitors' integrations pages. No login, no paywalled content. You are responsible for using the output in line with the terms of the sites involved and applicable law in your jurisdiction.

**Something looks wrong, or I have a feature request.** Please open an issue on the Actor's Issues tab in Apify Console with the run ID and, if possible, the `companyDomain` you ran it against — that's enough to reproduce most problems. Custom variants of this Actor (different discovery logic, extra sources, private integrations) can be discussed there too.
