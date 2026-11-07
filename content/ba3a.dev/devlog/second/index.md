---
title: "Second: the first real run"
date: 2026-11-04
draft: true
tags: [tools/claude-code, specloop]
series: devlog-start
summary: The loop on a real feature, what the reviews caught and where it got stuck.
---

<!-- TODO: rewrite -->

This is a placeholder post, the second part of a two-part series. The real second post replaces it.

## The run

I gave the loop a small feature and let it work through the steps. Most steps passed their review at the first attempt. The ones that did not were rejected for the same reason: an acceptance criterion that no test checked.

:::carousel[Three runs of the loop]
![A stack of three cards in blue, drawn as a progress board.](run-1.jpg "Run one: the board after the first steps.")

![A circular arrow in yellow on a green background.](run-2.jpg "Run two: a step that went around the loop twice.")

![A window with lines of text under a title bar, drawn in yellow.](run-3.jpg "Run three: the review that found a missing test.")
:::

## What the reviews caught

A review is only as good as its checklist. The criteria that were measurable, such as "exits with a non-zero status", were checked every time. The vague ones were waved through.

![A terminal window with green lines of text.](terminal.jpg "The terminal during the run (placeholder picture).")

## Counting the attempts

The number of attempts per step is a useful signal, and it is a one-liner:

```kotlin
fun attemptsPerStep(reviews: List<Pair<Int, Boolean>>): Map<Int, Int> =
    reviews.groupingBy { it.first }.eachCount()

fun main() {
    val reviews = listOf(1 to false, 1 to true, 2 to true)
    println(attemptsPerStep(reviews)) // {1=2, 2=1}
}
```

## What I would change

Write the acceptance criteria as something a test can check, and say so in the plan.
