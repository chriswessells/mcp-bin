# Scalability Review — mcp-bin Runner

**Reviewer**: Performance Engineering
**Date**: 2026-05-02
**Scope**: All design documents, requirements, and ADRs

## Executive Summary

The mcp-bin runner is a lightweight CLI shim with a narrow scope: resolve → download → cache → exec. Its scalability profile is dominated by I/O (network downloads, disk cache) rather than CPU or memory. The design is sound for its intended use case (single-user, single-machine, handful of MCP servers). The primary risks are around concurrent invocations, cache integrity under contention, and manifest growth over time.

Overall assessment: **No critical blockers for v1 launch.** Several medium-severity items warrant attention before scaling to many servers or high-frequency invocations.

---

## Findings

### 1. Lock Polling is Wasteful Under Contention

**Severity**: Medium
**Location**: `design/cache-manager.md` — Locking (R17), Acquire step 3f
**Issue**: Lock acquisition uses 1-second polling for up to 60 seconds. Under contention (e.g., 10 concurrent `npx` invocations for the same server), all waiters spin-poll the filesystem every second.
**Impact**: At 10+ concurrent invocations, this generates 600 stat/read syscalls over 60s per waiter. Negligible on local SSD, but noisy on network-mounted home directories (NFS, FUSE). Degrades at ~20+ concurrent waiters.
**Recommendation**: Acceptable for v1. If contention becomes common, consider `fs.watch()` on the lock file for event-driven wakeup, or an exponential backoff on the poll interval (1s → 2s → 4s).

---

### 2. SHA256 Verification on Every Cache Hit

**Severity**: Medium
**Location**: `design/cache-manager.md` — Lookup Flow, step 5
**Issue**: Every invocation computes a full SHA256 of the cached binary, even on cache hit. For large binaries (50–100MB Rust binaries are common), this adds 200–500ms of CPU-bound hashing on every cold start.
**Impact**: The requirement states "first run ~5s, subsequent runs <100ms." A 100MB binary hashes at ~400MB/s on Apple Silicon = ~250ms, violating the <100ms target. Degrades linearly with binary size.
**Recommendation**: This is mandated by R16 and ADR-005. Two options without overturning the decision:
  1. Cache the hash result with the binary's mtime+size as a validity key (skip re-hash if mtime and size unchanged). This is a local optimization that preserves the security property for the tamper-detection threat model (attacker who modifies the binary will change mtime/size unless they also control the filesystem metadata).
  2. Accept the latency for v1 and document it. The <100ms target in the quickstart may need revision for large binaries.

**Note**: This touches ADR-005. Recommend consulting the Chief Architect Engineer if option 1 is pursued, as it weakens the integrity check.

---

### 3. Manifest Growth is Unbounded

**Severity**: Medium
**Location**: `design/manifest-client.md` — Fetch Flow; `spec/requirements.md` — R23
**Issue**: The manifest is a single JSON file containing all servers × all versions × all platforms. With 50 servers × 10 versions × 3 platforms = 1,500 entries, the manifest could reach 200–500KB. At 500 servers, it's multi-MB.
**Impact**: Every first invocation (or hourly refresh) downloads the full manifest. Parse time is negligible, but download time on slow connections (100KB/s mobile hotspot) becomes noticeable at 500KB+. Signature verification of a multi-MB manifest is still fast (Ed25519 is O(n) but very fast).
**Recommendation**: Acceptable for v1 (likely <50 entries for months). For future scale:
  - Add `If-None-Match` / ETag support to skip re-download when manifest hasn't changed
  - Consider manifest sharding by server name (each server gets its own signed manifest fragment)
  - Add a `latest_versions_only` manifest variant that prunes old versions

---

### 4. No Download Resume / Partial Content Support

**Severity**: Low
**Location**: `design/downloader.md` — Download Flow
**Issue**: On retry after a partial download, the entire file is re-downloaded from byte 0. No `Range` header support.
**Impact**: For large archives (100MB+) on unreliable connections, a failure at 95% wastes significant bandwidth and time. With 3 retries × 100MB = potential 300MB wasted transfer. Hits the 5-minute overall timeout more easily.
**Recommendation**: Acceptable for v1. Most GitHub Release downloads complete in <30s. If large binaries become common, add HTTP Range resume: track bytes received, send `Range: bytes=<received>-` on retry, append to existing temp file.

---

### 5. Temp File Cleanup Race on Signal

**Severity**: Low
**Location**: `design/cli.md` — Signal Handler Phases
**Issue**: If the process receives SIGKILL (which cannot be caught), temp files are orphaned. The design handles SIGTERM and SIGINT but not uncleanable termination (OOM killer, `kill -9`).
**Impact**: Orphaned `.tmp` directories accumulate disk space. A 100MB archive left in `.tmp` per failed invocation. No automatic cleanup mechanism exists.
**Recommendation**: Add a startup sweep: on each invocation, before acquiring a lock, check for `.tmp` directories with no corresponding `.lock` file (or with a stale lock). Delete them. This is cheap (one readdir) and prevents unbounded disk growth from crashes.

---

### 6. No Cache Eviction Policy

**Severity**: Low
**Location**: `design/cache-manager.md` — Cache Layout
**Issue**: The cache grows monotonically. Every server × version is cached forever. With 50 servers × 10 versions × 50MB average = 25GB.
**Impact**: Disk usage grows without bound. On CI machines with small disks or containers with limited storage, this eventually causes failures. Threshold depends on environment — could be 5GB on a small CI runner.
**Recommendation**: Acknowledged as F2 (future consideration). For v1, document that users can safely `rm -rf ~/.cache/mcp-bin` to reclaim space. Consider adding `mcp-bin-runner --prune` or an LRU eviction (keep last N versions per server) in a future version.

---

### 7. Single-Threaded Manifest + Download Pipeline

**Severity**: Low
**Location**: `design/cli.md` — Orchestration Flow
**Issue**: The pipeline is strictly sequential: fetch manifest → resolve → check cache → download → extract → store → exec. There's no parallelism opportunity within a single invocation.
**Impact**: None for the current design (single binary per invocation). If the design ever supports batch operations (download multiple servers), the sequential pipeline would be a bottleneck.
**Recommendation**: No action needed for v1. The design correctly optimizes for the single-server-per-invocation use case. Note that Node.js's event loop already handles I/O concurrency within each step (e.g., streaming download + hash).

---

### 8. Retry Without Jitter

**Severity**: Low
**Location**: `design/downloader.md` — Retry Logic, Backoff delays
**Issue**: Fixed retry delays (1s, 2s, 4s) without jitter. If multiple runners hit the same transient failure simultaneously (e.g., GitHub rate limit), they all retry at the same instant, creating a thundering herd.
**Impact**: Only relevant when many machines download the same binary simultaneously (CI fleet scenario). 100 machines retrying at t+1s, t+3s, t+7s creates burst traffic. GitHub's CDN handles this fine, but a self-hosted manifest server might not.
**Recommendation**: The design already notes "jitter is a backlog item." Confirm this is tracked. Adding ±500ms random jitter to each delay is trivial and eliminates the thundering herd.

---

### 9. Ed25519 Signature Verification is Not a Bottleneck

**Severity**: N/A (positive finding)
**Location**: `design/manifest-client.md` — Signature Verification
**Issue**: None. Ed25519 verification is ~70μs regardless of manifest size (signature is over the full manifest bytes, but the crypto operation itself is constant-time after hashing). Even a 10MB manifest verifies in <1ms.
**Impact**: No scalability concern.
**Recommendation**: No action needed. Good design choice.

---

### 10. Streaming Extraction Prevents Memory Blowup

**Severity**: N/A (positive finding)
**Location**: `design/extractor.md` — Streaming Architecture; `design/downloader.md` — SHA256 Verification
**Issue**: None. Both the downloader (streaming SHA256) and extractor (streaming tar) avoid loading full archives into memory.
**Impact**: Memory usage stays constant (~64KB buffers) regardless of archive size.
**Recommendation**: No action needed. Good design choice.

---

## Concurrency Analysis

The design handles concurrency through file-based locking (R17). Key scenarios:

| Scenario | Behavior | Assessment |
|----------|----------|------------|
| 2 processes, same server+version | Lock serializes; second re-checks cache after lock | ✅ Correct |
| 2 processes, different servers | No contention; fully parallel | ✅ Correct |
| Process dies holding lock | Stale lock detection (dead PID or >10min) | ✅ Correct |
| 10+ processes, same server | Polling contention (Finding #1) | ⚠️ Acceptable |

The lock granularity (per server+version) is appropriate. No global locks exist.

---

## Growth Projections

| Metric | Current (v1) | 10x | 100x | Concern? |
|--------|-------------|-----|------|----------|
| Servers in manifest | 1–5 | 50 | 500 | Medium (Finding #3) |
| Versions per server | 1–3 | 30 | 300 | Medium (manifest size) |
| Binary size | 10–50MB | Same | Same | Low |
| Concurrent users | 1 | 10 | 100 | Low (per-machine tool) |
| Invocations/day | 10 | 100 | 1000 | Low (cache handles it) |
| Cache disk usage | 50MB | 500MB | 5GB | Low (Finding #6) |

---

## Startup Time Budget (Cache Hit Path)

| Step | Estimated Time | Notes |
|------|---------------|-------|
| Node.js startup | 30–50ms | npx overhead is separate (~200ms) |
| Arg parsing + platform detect | <1ms | Trivial |
| Manifest cache check (stat + read) | 1–5ms | Small file |
| Cache lookup (stat + stat + SHA256) | 50–500ms | **Dominates** — depends on binary size |
| spawn() | 1–5ms | OS fork |
| **Total (cache hit)** | **80–560ms** | Large binaries exceed <100ms target |

The npx overhead (~200–500ms for package resolution) is outside the runner's control and dominates cold starts. The runner itself is fast except for the SHA256 verification (Finding #2).

---

## Recommendations Summary

| # | Severity | Action | Effort |
|---|----------|--------|--------|
| 1 | Medium | Document polling behavior; backlog event-driven lock wait | Low |
| 2 | Medium | Consider mtime+size fast-path for cache verification (consult Chief Architect Engineer) | Medium |
| 3 | Medium | Add ETag/If-None-Match to manifest fetch | Low |
| 5 | Low | Add orphaned temp cleanup on startup | Low |
| 6 | Low | Document manual cache cleanup; backlog eviction policy | Low |
| 8 | Low | Add jitter to retry delays | Trivial |

No critical issues. The design is well-suited for its v1 scope.
