Integration Radar finds **the integrations your competitors offer and you don't**.

Give it one company domain. It works out who that company competes with, reads each competitor's integrations page, and lists every third-party product they offer that the company doesn't — ranked by how many competitors offer it, with the source pages named so you can check any row.

## What does Integration Radar do?

Enter a domain such as `apify.com`. In one run it:

1. **Names the competitors** — from an AI model's knowledge of the market, or from a list you supply.
2. **Finds each integrations page** — at `/integrations` first, then by searching the site.
3. **Extracts the products** listed on every page it reads, including your own.
4. **Diffs and ranks** what's missing, merging spelling variants so "AWS S3" and "Amazon S3" count once.

Use it to decide what to integrate next, to track what competitors add over time, or to build an integrations landing page. Run it on demand or on a schedule, and send the results to Google Sheets, Slack or a webhook through Apify's integrations.

## Input

| Field            | Type             | Required | Default | Description                                                                  |
| ---------------- | ---------------- | -------- | ------- | ---------------------------------------------------------------------------- |
| `companyDomain`  | string           | Yes      | —       | The company to analyze, as a bare domain: `apify.com`.                       |
| `maxCompetitors` | integer          | No       | `20`    | How many competitors to read, 1 to 30. The set is ordered most-direct-first. |
| `competitors`    | array of strings | No       | `[]`    | Explicit competitor domains. When set, these replace automatic discovery.    |

```json
{
    "companyDomain": "apify.com",
    "maxCompetitors": 20
}
```

Pass `competitors` when you know the market better than a model does. Entries that aren't bare domains are dropped with a warning in the log.

## Output

One row per product your competitors offer and you don't, ranked by `competitorCount`, capped at the top 100. Export as JSON, CSV, Excel or HTML.

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
    }
]
```

| Field             | Description                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| `candidate`       | The product name as it appeared on the competitor pages.                          |
| `slug`            | Normalized name used to merge spelling variants.                                  |
| `competitorCount` | How many competitors offer it. The ranking key, and your confidence column.       |
| `carriedBy`       | The competitor domains it was found on. Open them to verify the row.              |
| `description`     | One factual sentence on what the product is.                                      |
| `category`        | Short label such as `crm`, `spreadsheet`, `vector-database`.                      |
| `status`          | `BASELINE`, `NEW` or `SEEN` — see below.                                          |
| `weakEvidence`    | `true` when a source page was found by site search rather than a predictable URL. |

### NEW, SEEN and BASELINE

Each run saves what it found for that domain, and compares the next run against it.

- **First run:** every row is `BASELINE` — there's nothing to compare with yet.
- **After that:** `NEW` if the row wasn't in the previous list, `SEEN` if it was.

The comparison only holds if both runs read the same competitors, so changing `maxCompetitors` or `competitors` resets to `BASELINE` for one run. To track change over time, set the inputs once and leave them alone.

## How much does it cost?

Pay-per-event, **$0.02** each:

- **`source-analyzed`** — one integrations page fetched fresh and read. Cached pages (24 hours) and pages that never resolve are free.
- **`candidate-found`** — one row written to the dataset. Capped at 100 rows.

A run on `apify.com` at the default `maxCompetitors: 20` read 11 pages — 10 of the 20 competitors had a findable page, plus `apify.com` itself — and yields roughly 60–90 rows, so **about $1.40 to $2.00**. Rows dominate the bill and are charged on every run.

## Limitations

- Competitors come from an AI model's knowledge of the market, not a live search. One it doesn't know is never looked at; pass `competitors` to fix that.
- Fewer than half of a typical competitor set publishes a findable integrations page. One that publishes none contributes nothing and costs nothing.
- An integrations page shows what a company _publishes_, not everything it supports.
- Names are extracted by a model, so one can be odd or wrong — one competitor's integrations page turned out to be proxy setup guides. Every row names its sources in `carriedBy`, so a click settles it.
- The run fails outright if your own page can't be read, if no competitors can be determined, or if not one competitor page could be read. Each would otherwise produce a confidently wrong list.

## Feedback and support

Something looks wrong? Open an issue on the **Issues** tab with the run ID and the domain you ran. Integration Radar reads publicly published pages only — you're responsible for using the output in line with the terms of the sites involved.
