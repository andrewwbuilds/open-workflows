---
description: Run a dynamic workflow (planner/worker/reviewer swarm) on the given goal.
agent: build
model: anthropic/claude-sonnet-4-5
---

Use the `dynamic_workflow` tool for this request.

Goal: $ARGUMENTS

Choose sensible defaults unless the user specified otherwise:
- mode `research` for investigation, `implement` when edits are wanted, `review` for verification only.
- Set `allowEdits: true` only when the user explicitly wants code changes.
- Keep `maxRounds` between 2 and 5.
- Pass `successCriteria` if the user named any success conditions.

Do not ask follow-up questions before running it. After the workflow finishes, summarize the result for the user.