Integration Radar finds **the integrations your competitors offer and you don't**.

Give it one company domain. It works out who that company competes with, lists what each competitor integrates with, and reports every third-party product they offer that the company doesn't — ranked by how many competitors offer it.

## What does Integration Radar do?

Enter a domain such as `apify.com`. In one run it:

1. **Names the competitors** — from an AI model's knowledge of the market, or from a list you supply.
2. **Lists what each one integrates with**, including your own company.
3. **Diffs and ranks** what's missing, merging spelling variants so "AWS S3" and "Amazon S3" count once.

It answers from the model's knowledge of these companies. No websites are crawled, which makes a run fast and cheap — and means the results reflect what the model knows rather than what a page says today. See [Limitations](#limitations).

Use it to decide what to integrate next, or to sketch an integrations roadmap. Run it on demand or on a schedule, and send the results to Google Sheets, Slack or a webhook through Apify's integrations.

## Input

| Field            | Type             | Required | Default | Description                                                               |
| ---------------- | ---------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `companyDomain`  | string           | Yes      | —       | The company to analyze, as a bare domain: `apify.com`.                    |
| `maxCompetitors` | integer          | No       | `20`    | How many competitors to compare against, 1 to 30. Most-direct-first.      |
| `competitors`    | array of strings | No       | `[]`    | Explicit competitor domains. When set, these replace automatic discovery. |

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
        "status": "SEEN"
    }
]
```

| Field             | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `candidate`       | The product name.                                                           |
| `slug`            | Normalized name used to merge spelling variants.                            |
| `competitorCount` | How many competitors offer it. The ranking key, and your confidence column. |
| `carriedBy`       | The competitor domains it was attributed to.                                |
| `description`     | One factual sentence on what the product is.                                |
| `category`        | Short label such as `crm`, `spreadsheet`, `vector-database`.                |
| `status`          | `BASELINE`, `NEW` or `SEEN` — see below.                                    |

### NEW, SEEN and BASELINE

Each run saves what it found for that domain and compares the next run against it.

- **First run:** every row is `BASELINE` — there's nothing to compare with yet.
- **After that:** `NEW` if the row wasn't in the previous list, `SEEN` if it was.

The comparison only holds if both runs compare the same companies, so changing `maxCompetitors` or `competitors` resets to `BASELINE` for one run.

## How much does it cost?

Pay-per-event, **$0.02** each:

- **`source-analyzed`** — one company's integration list looked up. Lists are cached for 24 hours and cached lookups are free.
- **`candidate-found`** — one row written to the dataset. Capped at 100 rows.

At the default `maxCompetitors: 20` a first run looks up at most 21 companies, so **$0.42 at most in lookups**, plus $0.02 per row. Rows dominate the bill: a full 100 rows is $2.00, giving a ceiling of **$2.42 per run**. A re-run within 24 hours pays only for rows.

A run that fails charges nothing — events are billed only once rows are written.

## Limitations

- **The answer comes from an AI model's knowledge, not from your competitors' websites.** Nothing is verified against a live page. Treat the output as a well-informed starting list to check, not as a source of record.
- Coverage tracks how well-known a company is. A large company with a public integrations catalogue is described well; a small or very new one may return nothing, and is then skipped.
- An integration added recently may be missing, because the model's knowledge has a cutoff.
- A row with `competitorCount: 1` rests on a single competitor. Sort by `competitorCount` and treat the tail with suspicion.
- Names can be wrong or oddly spelled. `carriedBy` names the competitors a row was attributed to, so you can sanity-check it.
- The run fails outright if no integrations can be listed for your own company, if no competitors can be determined, or if not one competitor produced a list. Each would otherwise produce a confidently wrong list.

## Feedback and support

Something looks wrong? Open an issue on the **Issues** tab with the run ID and the domain you ran. You're responsible for using the output in line with the terms of the sites involved.
