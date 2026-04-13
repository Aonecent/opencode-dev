---
description: Run only the TDD development phase — generates tests and implementation using Red-Green-Refactor
agent: develop
subtask: true
---

Implement the feature using Test-Driven Development.

Read `.opencode/sdlc/requirements.md` and `.opencode/sdlc/design.md` if they exist. Otherwise use the description below.

Feature description:

$ARGUMENTS

Follow the Red-Green-Refactor cycle:
1. Generate test cases (develop-testgen)
2. Write failing tests (develop-red)
3. Write minimal implementation (develop-green)
4. Refactor (develop-refactor)
5. Run full test suite (develop-guard)

Save results to `.opencode/sdlc/development.md`.
