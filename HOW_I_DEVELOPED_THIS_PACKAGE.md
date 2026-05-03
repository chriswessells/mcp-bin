# How I Developed This Package

This package was built from scratch — spec to npm publish — in a single day (~6.5 hours wall-clock time) using an AI-assisted, spec-driven development workflow. This document describes the process, what worked, what didn't, and how it compares to other autonomous agentic coding approaches in the industry.

## The Numbers

| Metric | Value |
|--------|-------|
| Total wall-clock time | ~400 minutes (~6.5 hours) |
| Source files | 9 TypeScript modules |
| Lines of production code | ~750 |
| Test count | 48 (38 unit + 10 integration) |
| External dependencies | 1 (`tar-stream`) |
| Architecture decisions | 10 ADRs |
| Code review findings fixed | 14 Critical/High across 4 review cycles |
| Lessons documented | 30+ |

## The Process

### Phase 1: Specification (35 min)

Wrote a complete requirements specification (`spec/requirements.md`) covering:
- 41 numbered requirements (R1–R41)
- 12 security requirements (S1–S12)
- 15 error codes (E1–E15)
- 11 test scenarios (T1–T11)

Then ran a **7-persona review** of the spec. Seven specialized AI reviewers — Security, Scalability, Reliability, Maintainability, Marketability, Resilience, Profitability — each evaluated the spec from their exclusive domain. First round found 6 Critical and 17 High issues. Fixed them all, re-reviewed: 0 Critical, 0 High.

### Phase 2: Design (45 min)

Produced architecture documentation, 6 component designs with API contracts, and an implementation plan with a dependency DAG showing which tasks could run in parallel.

The **Chief Architect Engineer** persona (combining Werner Vogels and Linus Torvalds philosophies) resolved 3 ADR conflicts where review personas disagreed with settled architectural decisions. This prevented scope creep — 4 personas recommended expanding the env var denylist, but the Chief Architect Engineer chose a simpler escape hatch instead.

### Phase 3: Parallel Implementation (90 min)

Five components were implemented simultaneously by parallel subagents:
- Downloader (HTTP with retry, timeout, checksum)
- Extractor (tar.gz with path traversal protection)
- Cache Manager (atomic writes, file locking, sidecar verification)
- Manifest Client (Ed25519 signature verification, TTL cache, fallback)
- Process Runner (spawn, signal forwarding, env filtering)

Each subagent followed the API contracts from the design phase. Because interfaces were defined upfront, the components integrated cleanly.

### Phase 4: Integration + Testing (60 min)

CLI orchestration layer, then 10 integration tests covering the full pipeline: download → verify → cache → execute, plus error paths (checksum mismatch, path traversal, timeout, concurrent access, stale locks, corrupted cache).

### Phase 5: Ship (30 min)

Ed25519 key generation, author tooling, CI/CD, npm publish.

### Between Every Phase: Review Gates

After each implementation phase, all 7 review personas ran in parallel (~2 min wall-clock). Every Critical and High finding was fixed before advancing. This caught:

- Missing HTTP redirect support (GitHub Releases always 302s to CDN)
- Signal handlers that forgot to release lock files
- A replay attack vector in cached signature verification
- Placeholder keys that would silently fail in production

## What Made This Work

### 1. Spec-Driven Development

The spec was the source of truth. Code was a build artifact derived from it. This is the opposite of "vibe coding" — every line of code traces back to a numbered requirement.

**Why it matters**: Augment Code's research shows spec-driven workflows deliver 56% programming time reduction. Kiro (AWS) treats specs as primary artifacts. The industry is converging on this pattern because it gives AI agents unambiguous instructions and gives humans a reviewable contract.

### 2. Bounded-Scope Review Personas

The single biggest innovation in this workflow was giving each review persona **exclusive ownership** of specific concerns with explicit "do NOT review" boundaries.

Before bounding: 4 personas flagged the same issue, 30-40% false positive rate, developers stop reading after 2 sprints of noise (CodeAnt research, 2025).

After bounding: Each concern has exactly one owner. "No findings" is a valid output. False positive rate dropped below 10%.

This is not how most AI code review tools work. Tools like Greptile, CodeRabbit, and GitHub Copilot code review run a single model with a single prompt. They produce duplicate findings, miss domain-specific issues, and generate noise that increases PR review time by 91% (Faros data, 2026).

### 3. Phase-Aware Review

Scaffolding code shouldn't be reviewed for production performance. Integration code shouldn't be flagged for missing README. Each persona adapts its review depth to the current phase (spec → scaffolding → implementation → integration).

This eliminated an entire category of irrelevant findings that plague single-pass AI review tools.

### 4. Parallel Subagents with API Contracts

Five components built simultaneously by independent agents, all coding against the same typed interfaces. This is the pattern OpenAI's Codex Subagents (GA March 2026) and Claude Code Agent Teams are converging toward — but with a critical difference: the contracts were designed and reviewed *before* any code was written.

Most multi-agent systems fail at rates between 41% and 86.7% in production (ArXiv systematic analysis, 2026). The primary failure mode is semantic drift — agents making incompatible assumptions. API contracts designed upfront eliminate this class of failure entirely.

### 5. The Chief Architect Engineer as Scope Control

When 4 out of 7 review personas recommend the same change, it's tempting to accept it. But the Chief Architect Engineer's job is to defend settled decisions and prevent scope creep. It rejected expanding the env var denylist (a treadmill) and chose a one-line escape hatch instead. It rejected adding CLI flags (precedent-setting) and chose an env var.

This role doesn't exist in any commercial AI coding tool I'm aware of. Devin, Cursor, and Claude Code all lack a mechanism for defending architectural decisions against the pressure of accumulated review feedback.

## How This Compares to the Industry

### vs. Devin (Cognition Labs)

Devin operates autonomously in a sandboxed environment. Its PR merge rate climbed from 34% to 67% year-over-year, but it "falls apart the moment business logic gets nuanced" (Fordel Studios, 2026). Cognition's own performance review admits Devin is "senior-level at codebase understanding but junior at execution."

The mcp-bin approach is fundamentally different: the human defines the spec and architecture, AI implements and reviews, human approves between phases. This keeps the human in the loop for decisions while delegating the mechanical work.

### vs. Cursor / Claude Code (Interactive Agents)

These are the tools most developers actually use daily. Claude Code leads on developer satisfaction (46% most loved in a 15,000-developer survey). They excel at interactive, conversational development.

The mcp-bin workflow uses these tools differently — not as conversational partners but as orchestrated workers following precise instructions. The spec replaces the conversation. The review personas replace the "does this look right?" back-and-forth.

### vs. OpenAI Codex Subagents

Codex Subagents (GA March 2026) is the closest commercial analog to what was done here: a manager agent coordinates specialized workers in parallel. The key difference is that Codex operates in isolated sandboxes with no shared filesystem, while the mcp-bin subagents share a repository and coordinate through typed interfaces.

### vs. Kiro Spec-Driven Development

Kiro (AWS) pioneered the "specs as primary artifacts" approach. The mcp-bin workflow aligns closely with Kiro's philosophy but adds multi-persona review gates and a Chief Architect Engineer role that Kiro doesn't have. Kiro's approach is: spec → tasks → implement. This approach is: spec → review → design → review → plan → implement → review → fix → QA → document, with the review step being 7 specialized agents rather than one general-purpose check.

## What Didn't Work (First Time)

1. **Parallel subagents chose inconsistent patterns** — Each picked different import strategies, test patterns, and naming conventions. Fixed by specifying conventions in subagent instructions. This is the "semantic drift" problem that kills 41-86% of multi-agent systems.

2. **First review round was pure noise** — Before bounding persona scope, 4 reviewers flagged the same `files` field issue and 3 flagged the same dependency pinning. The fix was exclusive ownership boundaries — took 15 minutes to rewrite all 7 personas, saved hours of noise in subsequent reviews.

3. **TypeScript + Node.js ESM is a minefield** — `.js` imports, `--experimental-strip-types`, `tsx` loader requirements. Burned 10 minutes on import issues that had nothing to do with the actual logic. This is a toolchain problem, not an AI problem.

4. **Self-signed cert generation in pure Node.js** — 100 lines of hand-rolled ASN.1 DER construction for test infrastructure. Should have used a library or static fixtures. The AI generated working code, but it's opaque and fragile.

## The Meta-Insight

The AI coding landscape in 2026 has a gap: tools optimize for either **speed** (Devin, vibe coding) or **correctness** (manual review, traditional TDD). This workflow optimizes for both by separating concerns:

- Speed comes from parallel execution and automated review
- Correctness comes from specs, bounded-scope review, and quality gates

96% of developers don't trust AI code without verification (The New Stack, 2026). The answer isn't slower AI — it's structured verification that runs at AI speed.

The entire mcp-bin package — spec, design, 9 modules, 48 tests, 10 ADRs, npm publish — was built in 6.5 hours by one person orchestrating AI agents. Not because the AI is perfect, but because the process catches imperfections before they ship.

## Reproducing This Workflow

The complete workflow is documented in `agents/AGENTS.md`. The review personas are in `agents/*.md`. The architectural decisions are in `agents/ADR.md`. Everything about how this software was written is transparent and version-controlled in the repository.

If you want to apply this to your own project:

1. Write a spec with numbered requirements and acceptance criteria
2. Create 7 review personas with exclusive ownership boundaries and phase awareness
3. Design API contracts before writing code — this enables parallel implementation
4. Run reviews after every phase, not just at the end
5. Fix Critical/High before advancing; log Medium/Low as backlog
6. Add a Chief Architect Engineer role to defend decisions against accumulated review pressure
7. Document everything — lessons learned, time spent, decisions made

The process is the product. The code is just the output.
