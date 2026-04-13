---
description: Run only the DDD design phase — produces domain model, bounded contexts, and constraint analysis
agent: design
subtask: true
---

Perform a full Domain-Driven Design analysis for the following requirement.

Read `.opencode/sdlc/requirements.md` if it exists, otherwise use the requirement below directly.

Requirement / BDD Scenarios:

$ARGUMENTS

Run all design sub-agents in parallel (design-domain, design-context, design-model, design-behavior, design-service, design-constraint) and synthesize the results into `.opencode/sdlc/design.md`.
