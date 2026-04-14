---
description: Run only the DDD design phase — reads from 01-requirements.md, produces 02-design.md
agent: design
subtask: true
---

Execute Phase 2 (DDD Design) of the SDLC pipeline.

Read BDD requirements from `.opencode/sdlc/01-requirements.md` and write the DDD design to `.opencode/sdlc/02-design.md`.

If `01-requirements.md` does not exist, create it first by running `/sdlc <requirement>` to start the full pipeline from the beginning.

$ARGUMENTS
