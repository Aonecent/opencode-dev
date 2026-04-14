---
description: Resume an interrupted SDLC pipeline — reads PLAN.md task ledger and continues from the first incomplete phase
agent: orchestrator
subtask: true
---

Resume the SDLC pipeline from where it left off.

The orchestrator will:
1. Read `.opencode/sdlc/PLAN.md` to find the current pipeline state
2. Skip all phases that are already `DONE`
3. Resume from the first `PENDING` or `FAILED` phase
4. Continue through all remaining phases

If `.opencode/sdlc/PLAN.md` does not exist, start a new pipeline with `/sdlc <requirement>` instead.

$ARGUMENTS
