Integration Radar finds **the integrations your competitors carry and you don't**. Give it a company domain; it identifies that company's competitors, reads each one's integrations page, and reports every third-party product they list that is missing from the company's own — ranked by how many competitors actually carry each name, with the source pages cited.

## What does Integration Radar do?

Integration Radar answers one question: **what do my competitors integrate with that I don't?** Give it a domain such as `apify.com` and it names that company's competitors automatically — or takes the list from you — reads what each of them integrates with, and diffs all of it against the company's own integrations page.

The result is a ranked dataset of missing integrations, with evidence: every row lists the competitor pages it was found on, so you can open them and check rather than trust a score. Run it on demand from the Apify Console or API, schedule weekly re-runs to catch newly added competitor integrations, and pipe the output into Sheets, Slack or a BI tool through Apify's built-in integrations.

## Why use Integration Radar?

- **Product and partnerships teams** get a data-backed answer to "what should we integrate with next" instead of sales anecdotes.
- **Competitive intelligence** teams track what a competitor set has added since the last check — each finding is tagged `NEW` or `SEEN` automatically.
- **Marketing and SEO** teams researching integration landing pages get a ready list of products the market associates with the category.
- It replaces opening a dozen competitor sites and skimming them by hand.

## How to use Integration Radar

1. Open Integration Radar in the Apify Console, or call it via the API.
2. Enter the **Company domain** as a bare domain such as `apify.com`. This is the only required input.
3. Optionally set **Competitors** explicitly, or adjust **Maximum competitors**. The defaults work well for a first run.
4. Start the run — it typically finishes in 3–5 minutes.
5. Open the **Output** tab, or fetch the dataset via the API.
6. Re-run the same domain later to see which findings are genuinely `NEW`.

## Input

| Field            | Type             | Required | Default | Description                                                                                                            |
| ---------------- | ---------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `companyDomain`  | string           | Yes      | —       | The company to analyze, as a bare domain (e.g. `apify.com`).                                                           |
| `maxCompetitors` | integer          | No       | `20`    | How many competitors to read. The set is named most-direct-first, so a lower number keeps the closest ones. Minimum 1. |
| `competitors`    | array of strings | No       | `[]`    | Explicit competitor domains, as bare domains such as `rival.com`. When set, these replace automatic discovery.         |

```json
{
    "companyDomain": "apify.com",
    "maxCompetitors": 20
}
```

### Changing what the run reads resets the comparison

`NEW` means "no competitor we read last time carried this name" — honest only if both runs looked at the same pages. So the Actor fingerprints `companyDomain`, `maxCompetitors` and the competitor set it actually reads (after the `maxCompetitors` cut, however the set was obtained). When that fingerprint changes, the next run reports `BASELINE` for every row instead of a diff, and resumes `NEW`/`SEEN` tagging from the run after that.

## Output

Each row is one candidate integration your company doesn't have. Download it as JSON, HTML, CSV or Excel from the **Output** tab or the API.

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

| Field             | Type    | Description                                                                                     |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `candidate`       | string  | The product name, as extracted from its source pages.                                           |
| `slug`            | string  | Normalized form used to merge spelling variants ("AWS S3" and "Amazon S3" collapse to one row). |
| `competitorCount` | number  | How many distinct competitors carry this name. The ranking key.                                 |
| `carriedBy`       | array   | The competitor domains it was found on — open any of them to verify the finding.                |
| `description`     | string  | One factual sentence on what the product is.                                                    |
| `category`        | string  | Short category label (e.g. `crm`, `spreadsheet`).                                               |
| `status`          | string  | `BASELINE` on a first run or after the inputs changed; otherwise `NEW` or `SEEN`.               |
| `weakEvidence`    | boolean | `true` if a contributing page was found by search rather than a fixed URL guess — see the FAQ.  |

**Ranking is evidence, not a score.** Rows sort by `competitorCount`, ties broken alphabetically so the order is stable between runs. There is no priority or effort estimate, because the Actor doesn't know your roadmap, capacity or existing partnerships. And there is no evidence threshold: a name carried by one competitor is still reported, so read `competitorCount` as the confidence column and scan down until rows stop being useful.

## How much does it cost?

Pay-per-event, two events at **$0.02** each:

- **`source-analyzed`** — one integrations page fetched fresh and extracted, whether the company's own or a competitor's. Cached pages and pages that fail to resolve are free.
- **`candidate-found`** — one row written to the dataset (capped at 100 rows).

A live run against `apify.com` with `maxCompetitors: 20` resolved a usable page for **10 of the 20** competitors named, so it read 11 sources. Those pages yielded 144 names; after removing what `apify.com` already has, merging variants and dropping generic terms, expect roughly 60–90 rows.

|                              | Count       | Cost             |
| ---------------------------- | ----------- | ---------------- |
| `source-analyzed` (cold run) | 11          | $0.22            |
| `candidate-found`            | ~60–90 rows | $1.20–$1.80      |
| **Total**                    |             | **≈$1.42–$2.02** |

Rows dominate the bill, and they're charged on every run — so a warm re-run (pages served from cache) is cheaper, but not dramatically. Fewer than half of a typical competitor set publishes a findable integrations page, so fresh sources usually land well below `maxCompetitors`.

## Tips

- **Run it twice.** The first run for any domain is all `BASELINE`; `NEW` and `SEEN` only mean something from the second run onward. Schedule re-runs for ongoing change detection.
- **Widen `maxCompetitors`** for a broader sweep, up to the form's maximum of 30. That cap is a Console guard rail, not a hard limit — an API caller can pass more, at one `source-analyzed` event per page that resolves.
- **Pass `competitors` explicitly** when you know your market better than a model does. It skips discovery, costs nothing extra, and gives exact control over the comparison set.
- **Expect one `BASELINE` run** after editing `competitors` or `maxCompetitors`, or after deleting the cached seed. It's what stops a tuning change from being reported as competitor activity.
- **Check `weakEvidence` before trusting a `NEW` row.**

## FAQ, limitations, and support

**Does a missing integration mean my competitor doesn't have it?** No — it means it wasn't on the pages this Actor reads. An integrations page measures what a company _publishes_, not what it supports.

**Why are some names odd or irrelevant?** Not every competitor publishes an integrations page, and one that doesn't contributes nothing. "Integration" also means different things on different sites — one observed competitor's integrations page was really a set of proxy setup guides. With no evidence threshold, one-competitor names sit alongside five-competitor ones. And LLM extraction can occasionally invent a name; nothing cross-checks that automatically, which is what `carriedBy` is for.

**Where do the competitors come from?** From the model's knowledge of your market — cached permanently, so the set cannot drift between runs and fabricate `NEW` — or from the `competitors` input. (An earlier version read the company's own "alternatives" page; none of 22 mainstream SaaS domains tested published one.) The set is a starting point, so a competitor the model doesn't know is never looked at. That's a coverage limit, not an evidence one: every integration reported still comes from a page that was fetched and cited. Because the cache never expires, a company that starts competing with you after your first run won't join on its own. To refresh: pass `competitors`, change `maxCompetitors` (a new value seeds a fresh set), or delete the `seed-...` key for your domain from the `integration-radar` key-value store.

**What does `weakEvidence: true` mean?** Some pages can't be found at a predictable URL and are located by site-scoped search instead, which can resolve on one run and not the next. The Actor never reads an unresolved source as a removal — it records which sources its memory rests on, and only lets a candidate drop out on a run that read all of them. `weakEvidence` flags the rows resting on that less stable evidence.

**Is this legal?** Integration Radar reads only publicly published pages — no login, no paywalled content. You are responsible for using the output in line with the terms of the sites involved and applicable law.

**Something looks wrong?** Open an issue on the Actor's Issues tab with the run ID and the `companyDomain` you ran — that reproduces most problems. Custom variants can be discussed there too.
