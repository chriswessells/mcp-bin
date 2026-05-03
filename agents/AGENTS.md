# AGENTS.md — Development Workflow

This document defines the mandatory process for designing, reviewing, building, and shipping software in this project. All agents must follow this process.

---

## Phases

### Phase 1: Spec

Create a requirements specification in `spec/`.

- Define the problem, goals, constraints, and non-goals
- List numbered requirements (R1, R2, ...) with clear acceptance criteria
- Include security requirements, error handling, and testing requirements

**Output**: `spec/requirements.md`

### Phase 2: Spec Review

All 7 review personas evaluate the spec.

**Gate**: Fix all **Critical** and **High** findings before proceeding to design.

### Phase 3: Design

Produce architecture and component designs in `design/`.

- Architecture overview with component boundaries
- **API contracts** for every component interface — these enable parallel development
- Data model and schema
- Error handling strategy
- Technology choices with rationale

**Output**: `design/*.md`

### Phase 4: Plan

Produce an implementation plan.

- Ordered list of tasks with acceptance criteria
- **DAG** — dependency graph showing which tasks can run in parallel vs sequentially
- **Subagent instructions** — precise, unambiguous instructions for each task that a subagent can execute without follow-up questions
- Time estimates per task

**Output**: `design/plan.md` (includes DAG and instructions)

### Phase 5: Design/Plan Review

All 7 review personas evaluate the design, plan, DAG, and subagent instructions.

**Gate**: Fix all **Critical** and **High** findings before proceeding to code.

**Re-review rule**: If fixes change an API contract, data model, public interface, dependency, or error handling strategy, re-run all personas on the revised design.

### Phase 6: Code

Subagents implement the approved design following the DAG and instructions.

- Each subagent tracks time spent on their task
- Each subagent maintains a todo list
- Tests are written alongside code
- Build must pass before requesting review
- **If a subagent discovers something requiring a design change**: update the design documents first, then notify other subagents so they can update their components

### Phase 7: Code Review

All 7 review personas evaluate the implementation **after each implementation phase** (not just once at the end). For example, if the plan has Phase 1 (scaffolding), Phase 2 (parallel components), Phase 3 (integration), etc., a code review gate occurs after each phase completes.

**Gate**: Fix all **Critical** and **High** findings before advancing to the next implementation phase.

**Post-phase gate** (must complete before moving to next phase):
1. **Code review** — run all 7 personas in parallel
2. **Fix** — fix all Critical and High findings; re-review if fixes change API contracts
3. **QA verification** — run build, tests, and smoke-tests to verify code works as designed
4. **Documentation update** — update tracking documents:
   - `agents/TODO.md` — mark completed tasks, update in-progress
   - `agents/TIME_LOG.md` — log time spent
   - `agents/LESSONS_LEARNED.md` — record any new insights
   - `agents/ADR.md` — record any new decisions made during the phase

**Autonomy rule**: All steps within a phase (implementation, review, fix, QA, docs) execute without asking for user confirmation. Only ask the user for verification **between phases** — after the post-phase gate is fully complete and before starting the next phase.

### Phase 8: QA

After code is reviewed and committed, the QA agent tests the code.

- Verify the code actually works (not just compiles)
- Run the test suite
- Test edge cases and error paths
- Verify against the spec requirements

**Gate**: QA agent must approve before the task is marked complete in the todo list.

### Phase 9: Complete

- Update the todo list — mark work as complete only after QA approval
- Log time spent
- Record any lessons learned or architectural decisions

---

## Review Personas

7 personas review at each gate. Each has **exclusive ownership** of specific concerns (no overlap), **phase awareness** (adapts depth to spec/scaffolding/implementation/integration), and **calibrated severity** (concrete definitions per persona). Each produces findings rated **Critical | High | Medium | Low**.

"No findings." is a valid output — silence is better than noise.

| Persona | File | Exclusive Ownership |
|---------|------|---------------------|
| Security | `agents/security.md` | Input validation, injection, supply chain, secrets, crypto, file system security, network security, secure defaults |
| Scalability | `agents/scalability.md` | Performance bottlenecks, resource limits, caching strategy, concurrency, algorithmic complexity, startup time |
| Reliability | `agents/reliability.md` | Correctness under degraded conditions, data durability, idempotency, timeouts, observability, resource cleanup |
| Maintainability | `agents/maintainability.md` | Code organization, naming, test strategy, dependency management, build/CI complexity, type safety, API stability |
| Marketability | `agents/marketability.md` | Developer experience, documentation, adoption barriers, ecosystem fit, naming, distribution, community readiness |
| Resilience | `agents/resilience.md` | Blast radius, retry/backoff strategy, state consistency after failure, self-healing, dependency isolation, rollback |
| Profitability | `agents/profitability.md` | Build/CI costs, operational overhead, scope discipline, buy vs build, time to value, development velocity |

**Key distinction**: Reliability = "works correctly under normal/degraded conditions." Resilience = "recovers and contains damage when broken."

Every finding must include a **Tradeoff** field (ATAM principle: quality attributes compete).

### QA Agent

| Agent | File | Focus |
|-------|------|-------|
| QA | `agents/qa.md` | Functional testing, edge cases, integration testing, spec compliance |

### Chief Architect Engineer

| Agent | File | Focus |
|-------|------|-------|
| Chief Architect Engineer | `agents/chief_architect_engineer.md` | ADR enforcement, big architectural decisions, scope control |

The Chief Architect Engineer is **not** a regular reviewer. It is consulted in two situations:
1. When a persona or subagent proposes a change that contradicts an existing ADR — the Chief Architect Engineer defends or overturns the decision.
2. When an agent faces a big decision (architectural, strategic, or scope) that will be hard to reverse — the Chief Architect Engineer provides a recommendation.

---

## Review Gate Rules

1. All **Critical** and **High** findings must be fixed before advancing.
2. **Medium** and **Low** findings are logged in the todo list as backlog.
3. If fixes are substantial (change API contracts, data model, public interfaces, dependencies, or error handling), re-run all personas on the revised artifacts.
4. The gate ensures reviewers approve what will actually be built/shipped, not a prior version.

---

## Design Change Protocol

If any agent (during coding or review) discovers something that requires a design change:

1. **Stop** — do not implement a workaround
2. **Update** the design documents in `design/`
3. **Notify** other subagents working on dependent components
4. Other subagents update their components to match the revised design
5. If the change is substantial, trigger a re-review

---

## Subagent Requirements

- Track time spent on each task
- Maintain a todo list of their assigned work
- Follow the DAG — respect task dependencies
- Use API contracts — develop against the interface, not the implementation
- Write tests alongside code — **focus on critical and high-severity paths only; do not write tests for low-likelihood edge cases**
- Report blockers immediately rather than working around them

---

## Tracking Files

| File | Purpose |
|------|---------|
| `agents/TODO.md` | All work: completed, in-progress, planned, backlog |
| `agents/TIME_LOG.md` | Time spent per task |
| `agents/ADR.md` | Architecture Decision Records |
| `agents/LESSONS_LEARNED.md` | Retrospective notes |
