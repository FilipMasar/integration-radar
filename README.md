Integration Radar finds **the integrations your competitors carry and you don't**. Give it a company domain; it identifies that company's competitors, reads each one's integrations page, and reports every third-party product they list that is missing from the company's own — ranked by how many competitors actually carry each name, with the source pages cited.

Run it on the Apify Store: [apify.com/filipmasar/integration-radar](https://apify.com/filipmasar/integration-radar)

## What does Integration Radar do?

Integration Radar answers one question: **what do my competitors integrate with that I don't?** Give it a domain such as `apify.com` and it names that company's competitors — from a language model's knowledge of the market, or from a list you supply — resolves each competitor's integrations page, extracts the third-party products named on it, and diffs all of that against the company's own integrations page.

Every row is evidence, not a score: it lists the competitor domains the name was found on, so you can open them and check. Run it on demand from the Apify Console or the API, schedule weekly re-runs to catch newly added competitor integrations, and pipe the output into Google Sheets, Slack or a BI tool through Apify's built-in integrations.

## Why use Integration Radar?

- **Product and partnerships teams** get a data-backed answer to "what should we integrate with next" instead of sales anecdotes.
- **Competitive intelligence teams** track what a competitor set has added since the last check — each row is tagged `NEW` or `SEEN` from the second run onward.
- **Marketing and SEO teams** building integration landing pages get a ready list of products the market associates with the category.
- It replaces opening a dozen competitor sites and skimming them by hand.

## How to use Integration Radar

1. Open Integration Radar in the Apify Console, or call it via the API.
2. Enter the **Company domain** as a bare domain such as `apify.com`. This is the only required input.
3. Optionally set **Competitors** explicitly, or adjust **Maximum competitors**. The defaults work for a first run.
4. Start the run. It reads up to four pages at a time and typically finishes in a few minutes.
5. Open the **Output** tab, or fetch the dataset through the API.
6. Re-run the same domain later. The first run is a baseline; `NEW` and `SEEN` only mean something from the second run on.

## Input

| Field            | Type             | Required | Default | Description                                                                                                              |
| ---------------- | ---------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `companyDomain`  | string           | Yes      | —       | The company to analyze, as a bare domain (for example `apify.com`).                                                      |
| `maxCompetitors` | integer          | No       | `20`    | How many competitors to read. The set is ordered most-direct-first, so a lower number keeps the closest ones. Minimum 1. |
| `competitors`    | array of strings | No       | `[]`    | Explicit competitor domains, as bare domains such as `rival.com`. When set, these replace automatic discovery.           |

```json
{
    "companyDomain": "apify.com",
    "maxCompetitors": 20
}
```

Entries in `competitors` that are not bare domains are dropped with a warning; if none survive, the run fails rather than silently comparing against a shorter list.

### Changing what the run reads resets the comparison

`NEW` means "no competitor we read last time carried this name" — honest only if both runs looked at the same pages. So the Actor fingerprints `companyDomain`, `maxCompetitors` and the competitor set it actually reads (after the `maxCompetitors` cut, however the set was obtained). When that fingerprint changes, the next run reports `BASELINE` for every row instead of a diff, and resumes `NEW`/`SEEN` tagging on the run after that.

## Output

One row per candidate integration your company doesn't have, sorted by `competitorCount`, ties broken alphabetically by `slug` so the order is stable between runs. Download it as JSON, HTML, CSV or Excel from the **Output** tab or the API.

```json
[
    {
        "candidate": "Google Sheets",
        "slug": "google-sheets",
        "competitorCount": 4,
        "carriedBy": ["browse.ai", "phantombuster.com", "agenty.com", "dexi.io"],
        "description": "Cloud-based spreadsheet application for creating and editing tabular data.",
        "category": "spreadsheet",
        "status": "SEEN",
        "weakEvidence": false
    },
    {
        "candidate": "Pinecone",
        "slug": "pinecone",
        "competitorCount": 1,
        "carriedBy": ["firecrawl.dev"],
        "description": "Managed vector database for similarity search.",
        "category": "vector-database",
        "status": "NEW",
        "weakEvidence": true
    }
]
```

### Output fields

| Field             | Type    | Description                                                                                                                                     |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidate`       | string  | The product name as it appeared on its source pages.                                                                                            |
| `slug`            | string  | Normalized form used to merge spelling variants — "AWS S3" and "Amazon S3" collapse to one row. Not shown in the default Console view.          |
| `competitorCount` | number  | How many distinct competitors carry this name. The ranking key.                                                                                 |
| `carriedBy`       | array   | The competitor domains it was found on. Open any of them to verify the finding.                                                                 |
| `description`     | string  | One factual sentence on what the product is. `"Unknown."` when the model does not recognize the name, and empty if the description step failed. |
| `category`        | string  | Short kebab-case label such as `crm`, `spreadsheet`, `vector-database`. `unknown` when undescribed.                                             |
| `status`          | string  | `BASELINE` on a first run or after the inputs changed; otherwise `NEW` or `SEEN`.                                                               |
| `weakEvidence`    | boolean | `true` if any contributing page was found by site search rather than at a predictable URL — see the FAQ.                                        |

**Ranking is evidence, not a score.** There is no priority or effort estimate, because the Actor does not know your roadmap, capacity or existing partnerships. There is no evidence threshold either: a name carried by a single competitor is still reported, so read `competitorCount` as the confidence column and scan down until the rows stop being useful. The dataset is capped at the top 100 rows; the run log reports the full ranked count when it is larger.

## How much does it cost?

Pay-per-event, two events at **$0.02** each. These are the whole bill — the page fetches and the language-model calls behind them are included, not charged as separate platform usage.

- **`source-analyzed`** — one integrations page fetched fresh this run and extracted, whether the company's own or a competitor's. Pages served from cache, and pages that never resolve, are free.
- **`candidate-found`** — one row written to the dataset. Capped at 100 rows, so at most $2.00 per run.

A live run against `apify.com` with `maxCompetitors: 20` resolved a usable page for **10 of the 20** competitors named, so it read 11 sources. That source count is measured. The row count is an estimate: those pages yielded 144 extracted names, and after removing what `apify.com` already has, merging variants and dropping generic terms, expect roughly 60–90 rows.

|                              | Count       | Cost             |
| ---------------------------- | ----------- | ---------------- |
| `source-analyzed` (cold run) | 11          | $0.22            |
| `candidate-found`            | ~60–90 rows | $1.20–$1.80      |
| **Total**                    |             | **≈$1.42–$2.02** |

Rows dominate the bill and are charged on every run, so a warm re-run — page cache still valid — is cheaper, but not dramatically. Fewer than half of a typical competitor set publishes a findable integrations page, so fresh sources usually land well below `maxCompetitors`.

## Tips

- **Run it twice.** The first run for any domain is all `BASELINE`. Schedule re-runs for ongoing change detection.
- **Widen `maxCompetitors`** for a broader sweep, up to 30. Each competitor whose page resolves fresh adds one `source-analyzed` event; those that resolve nothing cost nothing.
- **Pass `competitors` explicitly** when you know your market better than a model does. It skips discovery and gives exact control over the comparison set.
- **Expect one `BASELINE` run** after editing `competitors` or `maxCompetitors`, or after deleting the cached seed. That is what stops a tuning change from being reported as competitor activity.
- **Check `weakEvidence` before acting on a `NEW` row.**

## FAQ, limitations, and support

**Where do the competitors come from?** From a language model asked to name direct competitors of your domain from its own knowledge of the market — not from a live search — or from the `competitors` input. The seeded set is cached permanently, so it cannot drift between runs and fabricate `NEW` findings. That makes it a starting point with a real coverage limit: a competitor the model does not know is never looked at, and a company that starts competing with you after your first run will not join the set on its own. To refresh it, pass `competitors`, change `maxCompetitors` (each value seeds its own set), or delete the seed key from the `integration-radar` key-value store on your account — for `apify.com` at `maxCompetitors: 20` that key is `seed-apify-com-20`, with every non-alphanumeric character replaced by a hyphen.

**Why did a competitor produce nothing?** The Actor guesses `https://<domain>/integrations` first, over plain HTTP and then with a headless browser, and rejects a page that is too thin, does not mention integrations, or looks like an article. If that fails it tries a site-scoped search for the domain and asks the model whether the result is really a list page. A competitor that publishes no such page, or hides it behind an unusual URL, contributes nothing and costs nothing. In the measured run, half the named set resolved no page.

**Does a missing integration mean my competitor doesn't have it?** No. It means it was not on the pages this Actor reads. An integrations page measures what a company _publishes_, not what it supports.

**Why are some names odd or irrelevant?** "Integration" means different things on different sites — one observed competitor's integrations page was really a set of proxy setup guides. Names are extracted by a language model, which can occasionally invent one; nothing cross-checks that automatically, which is what `carriedBy` is for. And with no evidence threshold, one-competitor names sit alongside five-competitor ones.

**When does the run fail outright?** When the company's own integrations page cannot be resolved or yields no names, when no competitors can be determined, or when not one competitor page could be read. Any of these would otherwise produce a confidently wrong gap list. A single competitor that errors mid-run is skipped, not fatal.

**What is cached, and for how long?** Fetched pages and their extracted name lists live in the `integration-radar` key-value store on your account for 24 hours; a failed resolution is remembered for 6 hours so a re-run does not repay for the same dead end; the competitor seed and the `NEW`/`SEEN` memory never expire. Because the store is shared across your runs, two runs on overlapping competitor sets reuse each other's pages.

**What does `weakEvidence: true` mean?** Some pages cannot be found at a predictable URL and are located by site-scoped search instead, which can resolve on one run and not the next. The Actor never reads an unresolved source as a removal: it records which sources its memory rests on, and only lets a candidate drop out on a run that read all of them. `weakEvidence` flags the rows resting on that less stable evidence.

**Is this legal?** Integration Radar reads only publicly published pages — no login, no paywalled content. You are responsible for using the output in line with the terms of the sites involved and applicable law.

**Something looks wrong?** Open an issue on the Actor's Issues tab with the run ID and the `companyDomain` you ran; that reproduces most problems. Custom variants can be discussed there too.
