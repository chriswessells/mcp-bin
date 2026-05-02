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

## In Progress

- [ ] Design phase (architecture, component designs, API contracts)

## Planned

- [ ] Design review (7 personas)
- [ ] Plan (task list, DAG, subagent instructions)
- [ ] Plan review (7 personas)
- [ ] Implementation
- [ ] Code review (7 personas)
- [ ] QA testing

## Backlog (Medium/Low from reviews)

- [ ] R16 cache-hit verification adds 100-200ms for large binaries — consider fast-path mtime/size check
- [ ] Manifest sharding for large registries (>50 servers) — per-server JSON files
- [ ] R19 retry backoff should include jitter (±50%) to prevent thundering herd
- [ ] Manifest response timeout could be reduced from 30s to 10s
- [ ] Maximum manifest size limit (e.g., 10MB)
- [ ] Maximum archive size limit (e.g., 500MB)
- [ ] Stale-while-revalidate pattern for manifest caching
- [ ] Maximum fallback manifest age (e.g., 7 days)
- [ ] Minimum binary size / ELF magic byte check after extraction
- [ ] Platform-appropriate cache paths (macOS ~/Library/Caches, Linux $XDG_CACHE_HOME)
- [ ] Confirm `@mcp-bin` npm scope is available
- [ ] Add competitive positioning ("Why not Docker/cargo-binstall?") to README
- [ ] Specify test framework: Node.js built-in test runner (`node:test`)
- [ ] Clarify P1 (Phase 2 standalone binary) distribution path (Homebrew tap + install script)
