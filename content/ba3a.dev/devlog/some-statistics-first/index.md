---
title: Some statistics first
date: 2026-11-17 15:41
tags: [development/AI, coffer, specloop, development/how-to]
series: AI-rebirth
draft: false
summary: "Before the deep dive into how I build with AI, the raw numbers behind Coffer's first release: 6,613 API calls, 164 subagents, a billion cached tokens and ~80k lines of code."
---

Before starting the deep dive into my most important thought on AI development, I'd like to share some stats on the example I'll be using for this series: [Coffer, the site engine this blog uses](https://ba3a.dev/made/coffer/). It's the project I started as an exercise in AI development on a new scale. I decided that AI should be used as an independent developer who knows their craft, and that I should stop controlling their technical decisions. So, I wrote down my functional requirements, gave AI full freedom over the solution and fed the spec into [Specloop, my harness for Claude Code](https://ba3a.dev/made/specloop/). So, in this article I'll give you some of the statistics I found interesting from the first release's implementation.

## Token totals

|                 | API calls | Input (uncached) |    Output | Cache write |    Cache read |
| --------------- | --------: | ---------------: | --------: | ----------: | ------------: |
| Main session    |       568 |              895 |   486,000 |   5,056,212 |   179,526,120 |
| Subagents (164) |     6,045 |           12,374 | 5,506,509 |  18,738,056 |   862,547,901 |
| Total           |     6,613 |           13,269 | 5,992,509 |  23,794,268 | 1,042,074,021 |

## Model, agent and subagent use

Models: nearly everything ran on Sonnet 5.5. Opus 5.5 accounts for 13 main calls and 16 subagent calls, about 93k output tokens in total.

Cache: cache reads are about 98% of all input tokens processed. That is expected here, because each subagent call re-reads a large cached prefix.

Subagent share: subagents account for about 92% of output and 83% of cache reads.

## Code production

Added since the branch base: 58 commits, 420 files and 82,493 lines. All figures are added lines; nothing was deleted relative to the base.

## Final result

| Category                                                              | Files |  Lines |
| --------------------------------------------------------------------- | ----: | -----: |
| coffer engine source (coffer/src)                                     |    74 | 26,941 |
| coffer engine tests                                                   |    58 | 26,471 |
| Repo tests (scripts/test, scripts/site-test, fixtures)                |    50 |  8,353 |
| coffer theme, example, i18n, LICENSE, CI, generators and other config |    82 |  7,211 |
| coffer docs (coffer/docs, README, CHANGELOG)                          |    31 |  3,739 |
| Repo scripts (deploy, refresh, Cloudflare, prepare, split)            |    11 |  3,283 |
| Site themes (templates, CSS, i18n)                                    |    16 |  1,404 |
| Root docs (AUTHORING.md, OPERATIONS.md, README and others)            |    31 |  1,282 |
| Content (posts, pages, YAML)                                          |    16 |    466 |
| GitHub Actions workflows                                              |     3 |    372 |
| Other content files                                                   |     6 |     77 |
| Total                                                                 |   378 | 79,599 |

## What's next

Next I'll go into deeper details on how and why I did what and what my thoughts are on the technology.