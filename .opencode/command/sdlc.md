---
description: Start the full SDLC pipeline — creates a task ledger and runs all phases from requirement through operations
agent: orchestrator
subtask: true
---

Start a new SDLC pipeline for the following requirement.

The orchestrator will:
1. Create `.opencode/sdlc/PLAN.md` as a file-based task ledger
2. Run all 6 phases in order, each reading from and writing to artifact files
3. Update the task ledger after each phase so the pipeline can be resumed if interrupted

Requirement:

$ARGUMENTS
