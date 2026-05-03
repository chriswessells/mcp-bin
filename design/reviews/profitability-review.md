# Profitability Review — mcp-bin Runner

**Reviewer**: Senior Engineering Manager (Cost Efficiency)
**Date**: 2026-05-02
**Verdict**: Proceed with noted optimizations. The project is lean for what it does, but there are opportunities to reduce scope and accelerate time-to-value.

---

## Summary

This is a well-scoped project with a single external dependency, minimal infrastructure cost (GitHub Pages), and a clear value proposition. The main cost risks are: over-engineering for a single-user scenario, development time on security features that may not justify their complexity at this scale, and the opportunity cost of building vs. adopting existing tools.

---

## Findings

### Finding 1: Ed25519 Signing Adds Significant Complexity for a Solo-Author Manifest

**Severity**: Medium
**Location**: `design/manifest-client.md`, `design/plan.md` (T4, T9)
**Issue**: Ed25519 manifest signing (ADR-004) adds ~60 min of implementation (T4 + T9), key management burden, a signing script, and ongoing operational overhead (must sign on every manifest update). For a manifest hosted on a GitHub Pages repo you control, the trust boundary is already GitHub's access controls.
**Cost**: ~1.5 hours dev time, ongoing signing ceremony on every release, risk of key loss requiring a new runner version.
**Recommendation**: This is an accepted ADR decision. If reconsidering, consult the Chief Architect Engineer. A pragmatic alternative: defer signing to Phase 2 and rely on HTTPS + GitHub repo access controls for v1. The manifest is version-controlled — tampering is auditable via git history.

---

### Finding 2: Manifest 1-Hour TTL Cache + Fallback Logic is Over-Engineered for Explicit Versioning

**Severity**: Low
**Location**: `design/manifest-client.md`, "Fetch Flow" and "Fallback Behavior"
**Issue**: The manifest is fetched on every cold run, cached for 1 hour, with fallback-to-stale logic. But versions are pinned explicitly in user configs (`"0.2.1"`). The manifest content for a given server+version is immutable — once published, it never changes. A simpler "cache forever per server+version" strategy would eliminate TTL logic, fallback logic, and the `.meta` file entirely.
**Cost**: ~30 min extra implementation for TTL/fallback logic that provides no value when versions are immutable.
**Recommendation**: Cache the resolved entry (url + sha256) permanently per server+version+platform tuple. Only re-fetch if the cache lookup misses. This eliminates the TTL, fallback, and `.meta` file. The manifest itself becomes a cold-start-only fetch.

---

### Finding 3: File-Based Locking is Complex — Concurrent Downloads are Rare

**Severity**: Low
**Location**: `design/cache-manager.md`, "Locking (R17)"
**Issue**: The locking implementation (PID checking, stale detection, 60s polling, 10-min timeout) is ~45 min of implementation and testing for a scenario that almost never occurs in practice. MCP servers are typically started once per editor session. Two processes downloading the same server+version simultaneously is an edge case.
**Cost**: ~45 min dev time, ongoing maintenance of lock logic, potential for subtle bugs (PID reuse, NFS edge cases).
**Recommendation**: Keep the lock but simplify: use `mkdir` as an atomic lock (create directory as lock token — fails if exists). Skip PID checking. Use a single 60s timeout with exponential backoff polling. If the lock is stale, the user can delete it manually. This cuts implementation time by ~20 min.

---

### Finding 4: Integration Test Suite is Expensive Relative to Project Size

**Severity**: Medium
**Location**: `design/plan.md`, T7 (Integration Tests)
**Issue**: 60 minutes estimated for integration tests that require a local HTTPS server, Ed25519 keypair generation, test binary packaging, and concurrent process spawning. This is the second-longest task and tests scenarios (concurrent downloads, stale locks) that are edge cases for a solo developer's tool.
**Cost**: 60 min dev time + ongoing maintenance as the codebase evolves. Integration tests are the most brittle test category.
**Recommendation**: Prioritize unit tests (already in T1–T5). For integration, implement only T2 (full cycle) and T3 (cache hit) initially. Defer T6 (concurrent), T10 (stale lock), and T7 (timeout) to when/if those bugs actually manifest. This saves ~30 min.

---

### Finding 5: `tar-stream` Dependency — Justified but Pin the Version

**Severity**: Low
**Location**: `design/architecture.md`, "Dependencies"
**Issue**: `tar-stream` is the only external dependency. It's well-maintained and lightweight. However, the `package.json` in the plan uses `^3.1.7` (caret range), which allows minor/patch updates that could introduce breaking changes or vulnerabilities.
**Cost**: Potential future debugging time if an auto-updated version breaks extraction.
**Recommendation**: Pin to exact version: `"tar-stream": "3.1.7"`. Update deliberately.

---

### Finding 6: Three Timeout Layers in Downloader — Correct but Test Cost is High

**Severity**: Low
**Location**: `design/downloader.md`, "Timeout Implementation"
**Issue**: Three timeout layers (connect 5s, response 30s, overall 5min) are architecturally correct but create 3x the test surface. Each timeout path needs its own test with timing-sensitive assertions.
**Cost**: ~15 min extra test development, potential for flaky CI due to timing.
**Recommendation**: Accept the implementation complexity (it's correct). For testing, use a single "overall timeout" test with a very short timeout (100ms) and a delayed mock server. Trust that if the AbortController works, the other timeouts (which use standard Node.js socket options) also work.

---

### Finding 7: No CI Pipeline Defined — Zero Build Cost Currently, but Technical Debt

**Severity**: Medium
**Location**: Not present in any design file
**Issue**: There's no CI/CD pipeline defined. This means zero CI cost today, but also no automated quality gate. For a solo developer, this is acceptable short-term, but the first bug shipped to users will cost more than setting up CI would have.
**Cost**: Opportunity cost — bugs caught later are more expensive. A GitHub Actions workflow running `tsc && node --test` costs ~0 (free tier: 2000 min/month).
**Recommendation**: Add a minimal `.github/workflows/ci.yml` in T0 (scaffolding). Just `npm ci && npm run build && npm test`. Takes 5 min to write, runs in <1 min per push, catches regressions immediately.

---

### Finding 8: Author Tooling (T8) is Premature — You're the Only Author

**Severity**: Low
**Location**: `design/plan.md`, T8 (Author Tooling)
**Issue**: `update-manifest.sh` is 30 min of work for a script you'll run maybe once per release. You could just edit the JSON by hand in 2 minutes.
**Cost**: 30 min dev time for a script used ~monthly.
**Recommendation**: Defer T8 entirely. Edit `manifest.json` by hand for the first few releases. Build the script when the manual process becomes painful (>5 servers or >2 releases/week). This is already aligned with ADR-007's spirit.

---

### Finding 9: Buy vs Build — Have You Considered Existing Solutions?

**Severity**: Medium
**Location**: `spec/requirements.md`, overall project
**Issue**: The core problem (download a platform-specific binary, cache it, run it) is solved by several existing tools: `eget`, `cargo-binstall`, `aqua`, or even a simple shell script wrapper. The unique value here is Kiro registry integration via `npx`.
**Cost**: ~6 hours of development for functionality that partially exists elsewhere.
**Recommendation**: The Kiro registry integration (npm package, positional args, env var config) is the unique value and justifies custom code. However, consider whether the download+cache+extract logic could be replaced by shelling out to `curl` + `tar` + `shasum` in a 50-line shell script wrapped by a thin Node.js CLI. This would eliminate `tar-stream`, the Downloader class, the Extractor class, and ~3 hours of work. **Tradeoff**: loses Windows future-proofing and fine-grained error handling. Given ADR-003 already excludes Windows, this is worth considering. Flag for Chief Architect Engineer.

---

### Finding 10: Total Development Estimate (6h) is Reasonable

**Severity**: Low (positive finding)
**Location**: `design/plan.md`, "Time Estimate Summary"
**Issue**: N/A — this is a positive observation.
**Cost**: 6 hours for a complete, tested, secure binary distribution system is efficient.
**Recommendation**: The critical path (3.5h) is well-identified. Parallelize T1–T5 if using subagents. Ship T6 (CLI) as the MVP gate — integration tests (T7) can follow.

---

## Infrastructure Cost Analysis

| Item | Cost | Notes |
|------|------|-------|
| GitHub Pages hosting | $0 | Free for public repos |
| npm registry (publish) | $0 | Public packages are free |
| GitHub Actions CI | $0 | Free tier covers this easily |
| Binary hosting (GitHub Releases) | $0 | Free for public repos |
| Domain/DNS | $0 | Using github.io subdomain |
| **Total monthly cost** | **$0** | |

This is an excellent cost profile. Zero infrastructure spend.

---

## Operational Overhead Estimate

| Activity | Frequency | Time per occurrence |
|----------|-----------|-------------------|
| Release new server version | ~2x/month | 10 min (build + update manifest + sign) |
| Runner maintenance | ~1x/quarter | 2–4 hours (dependency updates, bug fixes) |
| User support | ~1x/month | 15 min |
| **Monthly total** | | **~1 hour** |

Signing ceremony (Finding 1) adds ~5 min per release. Without it: ~5 min per release.

---

## Recommendations Summary (Priority Order)

1. **Add CI in T0** — 5 min investment, prevents expensive bugs (Finding 7)
2. **Simplify manifest caching** — cache resolved entries permanently, drop TTL/fallback (Finding 2)
3. **Defer T8 (author tooling)** — edit JSON by hand until it hurts (Finding 8)
4. **Reduce integration test scope** — T2 + T3 only for v1 (Finding 4)
5. **Pin tar-stream version** — exact version, not caret range (Finding 5)
6. **Consider shell-out approach** — flag for Chief Architect Engineer (Finding 9)
7. **Simplify locking** — mkdir-based, no PID checking (Finding 3)

**Estimated savings if all adopted**: ~1.5–2 hours of development time, reduced ongoing maintenance burden, faster time to first working binary.

---

## Chief Architect Engineer Escalations

The following findings conflict with or question accepted ADRs:

| Finding | ADR | Recommendation |
|---------|-----|---------------|
| #1 (Ed25519 complexity) | ADR-004 | Consider deferring to Phase 2 |
| #9 (shell-out vs custom code) | ADR-002, ADR-003 | Consider curl+tar+shasum approach |

These should be reviewed by the Chief Architect Engineer before implementation begins.
