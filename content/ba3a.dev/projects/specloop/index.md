<!-- TODO: rewrite -->

- You hand it a spec, and Claude is walked through phases; a phase only completes when its check passes.
- Runs in your normal Claude Code session, no API keys, no separate orchestrator.
- Guard rails restrict edits per phase and block pushes until the work is done.
- Single mode gives one reviewable diff; feature mode splits a big spec into steps, each reviewed and committed.
