---
description: Run only the integration and E2E testing phase — reads from artifacts, writes 04-test-report.md
agent: test
subtask: true
---

Execute Phase 4 (Integration & E2E Testing) of the SDLC pipeline.

Read:
- BDD acceptance criteria from `.opencode/sdlc/01-requirements.md`
- Implementation summary from `.opencode/sdlc/03-development.md`

Write and execute integration and E2E tests. Save the test report to `.opencode/sdlc/04-test-report.md`.

$ARGUMENTS
