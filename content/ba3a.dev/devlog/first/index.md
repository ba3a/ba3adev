---
title: "First: why I put a loop around Claude Code"
date: 2026-11-01
draft: true
tags: [tools/claude-code, specloop]
series: devlog-start
summary: Why a plan, implement and review loop beats one long prompt, and the first sketch of it.
---

<!-- TODO: rewrite -->

This is a placeholder post. It exists so that the devlog has something to show: headings, a carousel, a captioned picture, a highlighted code block, a hierarchical tag and a project block. The real first post replaces it.

## Why a loop

A long prompt asks a model to hold the whole feature in its head. A loop splits the feature into small steps, gives each step to a fresh session and checks the result before the next step starts. Nothing in the loop is clever; the value is that every step has a defined end.

![A desk with an editor window open on a plan.](desk.jpg "The desk where the first sketch was drawn (placeholder picture).")

## How it works

The loop has three phases for every step, and each one ends with something that can be checked.

### Plan

The plan is a list of steps with acceptance criteria. It is written once, reviewed by a human and kept in the repository, so that a later session can read it.

### Implement and review

A step is implemented test first, then reviewed against its acceptance criteria. A rejected review goes back to the implementation with its findings.

:::carousel[Three early sketches of the loop]
![A circular arrow around a filled circle, drawn in green.](sketch-1.jpg "The loop as a circle: plan, implement, review.")

![Three overlapping cards in purple, one per phase.](sketch-2.jpg "The same loop as a stack of cards.")

![A window with lines of text under a title bar, drawn in pink.](sketch-3.jpg "What a session sees: one step and its criteria.")
:::

## A sketch in Kotlin

The order of the steps is plain data. This is the whole selection logic of a first prototype:

```kotlin
data class Step(val id: Int, val title: String, val done: Boolean = false)

fun nextStep(steps: List<Step>): Step? =
    steps.firstOrNull { !it.done }

fun main() {
    val plan = listOf(Step(1, "Scaffold", done = true), Step(2, "Parse the plan"))
    println(nextStep(plan)?.title ?: "Nothing left to do")
}
```

## What comes next

The second part runs the loop on a real feature and looks at where it got stuck.
