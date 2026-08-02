---
description: Run a dynamic_workflow (planner/worker/reviewer swarm) for the given goal.
agent: build
---

You MUST call the `dynamic_workflow` tool for this request. Do not answer from your own knowledge.

Goal text from the user (verbatim, everything after `/workflow `):
$ARGUMENTS

Choose sensible defaults unless the user specified otherwise:
- mode `research` for investigation, `implement` for code changes, `review` for verification.
- Set `allowEdits: true` only when the user explicitly wants code changes.
- Keep `maxRounds` between 2 and 5.
- Pass `successCriteria` if the user named any success conditions (e.g. "must pass tests", "must not change X").

Pass `goal` to the tool with the user text above. Do not add clarifying questions first. After the tool returns, summarize the result for the user in plain language and list the session IDs so they can navigate to any child session.