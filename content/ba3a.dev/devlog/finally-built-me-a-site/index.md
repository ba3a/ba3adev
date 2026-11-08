---
title: Finally built me a site
date: 2026-11-08 16:33
tags: [development/AI, coffer, specloop, development/how-to]
series: AI-rebirth
draft: false
---

## Preamble

For years I wanted a personal site. Something between a blog, a dump of write-ups, and a project showcase.

Off-the-shelf engines were either monstrous, gave me too little control, or both. Every time I sat down to build my own, I over-engineered it, got distracted after a couple of commits, and by the next attempt the whole concept was outdated.

## The Reality Check

Then Misha Tiunov launched his [site](https://ebgdae.ru/) — fully static. Pages rendered ahead of time, lightweight HTML on the server. No backend, no database, no pricey VPS.

And it made me wonder: do I really need a JVM, a DI container and an RDBMS to serve a few kilobytes of text to ten visitors a month? Read-only notes. I don't even want comments.

## My Identity Crisis

At the same time, I'm rewiring myself from an AI-assisted senior developer into a full-time AI wrangler. So the engine became my training ground.

I wrote a spec that deliberately named zero technical solutions. Only what I have (a domain on Cloudflare) and what I want: publishing by git push, multiple blogs, themes, tags, a project showcase.

Fed it to my self-made [Claude harness](https://ba3a.dev/made/specloop/). The beast chugged for about three days, produced 60 commits — and voilà.

## The Result

What came out:

- Hosting on Cloudflare's S3-compatible storage — the free tier will last me a very long time
- Build on GitHub Actions, on push to main and on a schedule — also free at my scale
- I write markdown in a plain text editor, push to main, and a few minutes later it's live

## I'll Explain

Next, I'll go deeper into my current development process and how I believe we, former programmers, should adapt to the modern AI reality. So this blog post is the first in the series.