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

All 7 review personas evaluate the implementation.

**Gate**: Fix all **Critical** and **High** findings before committing.

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

7 personas review at each gate. Each produces findings rated **Critical | High | Medium | Low**.

| Persona | File | Focus |
|---------|------|-------|
| Security | `agents/security.md` | Injection, supply chain, least privilege, data leakage, secure defaults |
| Scalability | `agents/scalability.md` | Performance bottlenecks, resource limits, growth patterns, caching |
| Reliability | `agents/reliability.md` | Failure modes, durability, recovery, graceful degradation |
| Maintainability | `agents/maintainability.md` | Code organization, test strategy, dependencies, documentation |
| Marketability | `agents/marketability.md` | Developer experience, documentation quality, adoption barriers, ecosystem fit |
| Resilience | `agents/resilience.md` | Fault tolerance, blast radius, cascading failures, self-healing |
| Profitability | `agents/profitability.md` | Cost efficiency, resource usage, build/deploy costs, operational overhead |

### QA Agent

| Agent | File | Focus |
|-------|------|-------|
| QA | `agents/qa.md` | Functional testing, edge cases, integration testing, spec compliance |

### Decision Maker

| Agent | File | Focus |
|-------|------|-------|
| Decision Maker | `agents/decision_maker.md` | ADR enforcement, big architectural decisions, scope control |

The Decision Maker is **not** a regular reviewer. It is consulted in two situations:
1. When a persona or subagent proposes a change that contradicts an existing ADR — the Decision Maker defends or overturns the decision.
2. When an agent faces a big decision (architectural, strategic, or scope) that will be hard to reverse — the Decision Maker provides a recommendation.

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
- Write tests alongside code
- Report blockers immediately rather than working around them

---

## Tracking Files

| File | Purpose |
|------|---------|
| `agents/TODO.md` | All work: completed, in-progress, planned, backlog |
| `agents/TIME_LOG.md` | Time spent per task |
| `agents/ADR.md` | Architecture Decision Records |
| `agents/LESSONS_LEARNED.md` | Retrospective notes |
