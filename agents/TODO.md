# TODO

## Completed

- [x] Create spec/requirements.md
- [x] Create agents/ workflow and persona prompts
- [x] Spec review round 1 (7 personas) — 6 Critical, 17 High found
- [x] Fix all Critical and High findings
- [x] Spec re-review round 2 (7 personas) — 0 Critical, 0 High
- [x] Fix Medium findings from re-review
- [x] Create ADR.md with 10 architectural decisions
- [x] Create start_design.md for fresh context
- [x] Design phase — architecture.md, 6 component designs, plan.md with DAG
- [x] Design review round 1 (7 personas) — 0 Critical, 8 High, ~30 Medium found
- [x] Chief Architect Engineer review — 3 ADR conflicts resolved (ADR-010 modified, ADR-004 upheld, ADR-006 modified)
- [x] Fix all Critical and High findings (8 fixes)
- [x] Fix Medium findings (9 fixes)

## In Progress

- [ ] Implementation Phase 5 (T9: Ed25519 key generation & pinning)

## Completed — Implementation

- [x] T0: Project scaffolding (package.json, tsconfig, types, errors, platform, LICENSE, CI)
- [x] T0 code review (7 personas) — 0 Critical, 0 High, 5 Medium
- [x] Persona improvement — rewrote all 7 personas with ownership boundaries, phase awareness, severity calibration
- [x] T1–T5: Parallel component implementation (downloader, extractor, cache-manager, manifest-client, process-runner)
- [x] T1–T5 code review (7 personas) — 1 Critical, 10 High (8 unique after dedup), ~15 Medium
- [x] Fix all Critical/High findings (10 fixes applied)
- [x] QA verification — build clean, 38/38 tests pass, all smoke tests pass
- [x] T6: CLI integration (src/cli.ts — 108 lines)
- [x] T6 code review (7 personas) — 0 Critical, 1 High, 8 Medium
- [x] Fix High finding (signal handler lock release)
- [x] QA verification — build clean, 38/38 tests pass, smoke tests pass
- [x] T7: Integration tests (10 tests covering T2–T11 spec requirements)
- [x] T7 code review (7 personas) — 0 Critical, 3 High, ~10 Medium
- [x] Fix 3 High findings (server close drain, harness signal handling, shared state try/finally)
- [x] QA verification — build clean, 48/48 tests pass, smoke tests pass

## Planned

- [ ] T8: Author tooling
- [ ] T9: Ed25519 key generation & pinning
- [ ] Configure CI/CD using GitHub Actions

## Backlog (Medium from Phase 4 code review)

- [ ] Use NODE_EXTRA_CA_CERTS instead of NODE_TLS_REJECT_UNAUTHORIZED=0 in integration tests
- [ ] Use minimal env allowlist in test `run()` helper instead of spreading process.env
- [ ] Increase concurrency test from 3 to 10+ processes for better lock contention coverage
- [ ] Extract self-signed cert generation to tests/fixtures/tls.ts or use `selfsigned` package
- [ ] Replace mutable shared state (archiveBuf, slowMode) with per-request dispatch table
- [ ] Assert post-concurrency state consistency (sidecar hash, no .tmp, no .lock)
- [ ] Add negative test: wrong public key → E10 signature verification failure
- [ ] Add integration test verifying env var denylist (ADR-010) end-to-end
- [ ] Assert both error code AND human-readable description in error tests
- [ ] Add npm cache to CI workflow (actions/setup-node cache: 'npm')

## Backlog (Medium from Phase 3 code review)

- [ ] Signal handler bypasses finally block — lock released synchronously but releaseLock() still runs (harmless double-unlink, but asymmetric)
- [ ] No timeout on manifest fetch at CLI layer (ManifestClient has internal 30s timeout — verify)
- [ ] parseArgs mixes process.exit with throw for different validation failures (testability)
- [ ] Inline signal handler block could be extracted if it grows
- [ ] `download()` call passes `undefined` positional arg — fragile if signature changes
- [ ] MCP_BIN_CHECK output goes to stderr only — not scriptable
- [ ] Custom manifest URL warning fires on every invocation for enterprise users
- [ ] No --help / --version flags (ADR-006 says no CLI flags — would need Chief Architect Engineer ruling)
- [ ] No progress indicator on first-run download (silent multi-second hang)
- [ ] MCP_BIN_CACHE_DIR not validated against path traversal (CacheManager handles via SAFE_NAME_RE on inputs)

## Backlog (Medium from Phase 2 code review)

- [ ] Error messages lack remediation hints (suggest next steps to user)
- [ ] Error codes (E1, E4, etc.) not surfaced in error messages — add `[E4]` prefix
- [ ] Remove dead `CONNECT_TIMEOUT_MS` constant in manifest-client.ts
- [ ] Add lock poll jitter to prevent thundering herd under contention
- [ ] Add extraction size limit (e.g., 500MB) to prevent tar bombs
- [ ] Manifest cache directory should use mode 0o700 (consistent with cache-manager)
- [ ] Manifest cache temp files should use mode 0o600
- [ ] Non-HTTPS URL rejection should say "Only HTTPS URLs are supported"
- [ ] Log filtered env vars when MCP_BIN_DEBUG=1
- [ ] Log retry attempts when MCP_BIN_DEBUG=1
- [ ] Log stale lock breaks to stderr
- [ ] Include cache age in fallback warning message
- [ ] Manifest fetch: add single retry on cold start (no cache exists)
- [ ] Misleading SignatureVerificationError when .sig CDN is down — fall back to full cache
- [ ] Extract sha256File to shared utility (deduplicate downloader + cache-manager)
- [ ] `fetchWithTimeout` wrapper adds no value — inline it
- [ ] `ProcessRunner` interface/factory may be over-engineering for single implementation
- [ ] `DownloaderConfig` and `DEFAULT_CONFIG` exports may be unnecessary public API

## Backlog (Low from design reviews)

- [ ] R16 cache-hit verification adds 100-200ms for large binaries — consider fast-path mtime/size check (consult Chief Architect Engineer re: ADR-005)
- [ ] Manifest sharding for large registries (>50 servers) — per-server JSON files
- [ ] Maximum manifest size limit (e.g., 10MB)
- [ ] Maximum archive size limit (e.g., 500MB)
- [ ] Maximum extracted file size limit (e.g., 500MB)
- [ ] Stale-while-revalidate pattern for manifest caching
- [ ] Maximum fallback manifest age (e.g., 7 days)
- [ ] Minimum binary size / ELF magic byte check after extraction
- [ ] Platform-appropriate cache paths (macOS ~/Library/Caches, Linux $XDG_CACHE_HOME)
- [ ] Confirm `@mcp-bin` npm scope is available
- [ ] Add competitive positioning ("Why not Docker/cargo-binstall?") to README
- [ ] Clarify P1 (Phase 2 standalone binary) distribution path (Homebrew tap + install script)
- [ ] Ed25519 key rotation mechanism (multi-key support, key ID in .sig header)
- [ ] Orphaned temp directory cleanup on startup
- [ ] Cache eviction policy (keep last N versions per server)
- [ ] Download resume via HTTP Range header
- [ ] ETag/If-None-Match for manifest fetch
- [ ] Refresh lock mtime during long downloads
- [ ] Check for symlinks before writing to cache paths
- [ ] Wrap extraction errors with context ("archive may be corrupt")
- [ ] `mcp-bin warmup <server> <version>` pre-download command
- [ ] Document WSL2 compatibility for Windows users
- [ ] npm 2FA + provenance attestation on publish
