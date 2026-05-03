# Chief Architect Engineer Review

**Date**: 2026-05-02
**Reviewer**: Chief Architect Engineer (Werner Vogels × Linus Torvalds synthesis)

---

## CONFLICT 1: ADR-010 — Denylist approach for env var filtering

- **Decision**: ADR-010
- **Original rationale**: Denylists are inherently incomplete but most MCP servers need a broad environment to function. Accepted denylist for v1 because an allowlist would break too many servers. Override via Kiro registry `environmentVariables` array.
- **Proposed change**: (a) Expand denylist with `/_TOKEN$/`, `/_API_KEY$/`, `/^NPM_/`, `/^DOCKER_/`, `/^SSH_/`, `/^VAULT_/`. (b) Add `MCP_BIN_ALLOW_ENV` escape hatch for users who need specific vars like `AWS_REGION`.
- **Verdict**: Modify
- **Reasoning**:

The ADR explicitly acknowledged "denylists are inherently incomplete" and said "may revisit if security incidents occur." Four of seven reviewers flagging this is evidence enough — we don't need to wait for an incident when the gaps are this obvious.

However, I'm splitting the two proposals:

**(a) Expand the denylist — UPHELD (reject).** Adding six more regex patterns is a treadmill. Every new cloud service, every new secret manager, every new CI system adds another pattern. This is the wrong direction. The current list is "good enough" for v1 — it catches the most common footguns. Expanding it creates a false sense of completeness and maintenance burden. If we're going to improve this, we do it with (b), not by playing whack-a-mole.

**(b) Add `MCP_BIN_ALLOW_ENV` — ACCEPTED.** This is the right fix. It's a two-way door (easily reversible), it's simple (comma-separated list, one env var), it solves the real customer problem (`AWS_REGION` being blocked), and it doesn't expand the denylist maintenance surface. Implementation is ~10 lines of code in `filterEnv()`.

The semantics: `MCP_BIN_ALLOW_ENV=AWS_REGION,AWS_DEFAULT_REGION` overrides the denylist for those specific variable names. Exact match only — no globs in the allowlist. This keeps it dead simple and auditable.

**ADR-010 amendment**: Add `MCP_BIN_ALLOW_ENV` (comma-separated list of exact env var names to pass through despite matching denylist patterns). Do not expand the denylist patterns.

---

## CONFLICT 2: ADR-004 — Ed25519 manifest signing as a launch requirement

- **Decision**: ADR-004
- **Original rationale**: Security review flagged that SHA256 verification alone is "security theater" if the manifest host is compromised — attacker controls both URLs and checksums. The runner executes arbitrary binaries, so the trust chain must be strong.
- **Proposed change**: Defer signing to Phase 2. Rely on HTTPS + GitHub repo access controls for v1.
- **Verdict**: Uphold
- **Reasoning**:

The Profitability persona's argument is "1.5 hours of implementation time." That's not a serious cost argument for a security control protecting arbitrary code execution. Let me be blunt: this runner downloads binaries from the internet and executes them. That is the single most dangerous thing software can do. The trust chain is not optional.

The "GitHub access controls are sufficient" argument fails the Vogels test: everything fails all the time. GitHub accounts get compromised. PATs leak. If someone pushes a malicious manifest to the GitHub Pages branch, without signing, every user who runs `npx @mcp-bin/runner` in the next hour executes attacker-controlled code. With signing, the attacker also needs the private key, which lives offline.

1.5 hours is nothing. The key management "burden" is: generate a key once, store it safely, sign the manifest when you update it. For a solo developer updating a manifest monthly, this is a 30-second `openssl` command in the release script.

The Security persona is correct: without signing, SHA256 verification is security theater. Ship with signing or don't ship at all.

**ADR-004 stands. No modification.**

---

## CONFLICT 3: ADR-006 — Environment variables only, no CLI flags

- **Decision**: ADR-006
- **Original rationale**: CLI flags conflict with R14 (forward additional arguments to the binary). Ambiguity about which flags belong to the runner vs the child. Env vars are unambiguous.
- **Proposed change**: Add `--check` flag for self-test/health-check, or alternatively use `MCP_BIN_CHECK=1` env var.
- **Verdict**: Modify (accept the env var alternative)
- **Reasoning**:

The `--check` flag proposal is reasonable in isolation, but it opens a door. Today it's `--check`. Tomorrow it's `--verbose`. Then `--no-cache`. Then `--force-download`. Every flag is a precedent. ADR-006 drew a clean line: env vars only, no ambiguity. I'm not opening that door.

However, the *need* is real. A health-check mode that verifies "manifest reachable, signature valid, cache writable, platform supported" is genuinely useful for debugging broken setups. The env var alternative (`MCP_BIN_CHECK=1`) satisfies this need without violating ADR-006.

Semantics: When `MCP_BIN_CHECK=1` is set, the runner performs all steps up to (but not including) binary execution, prints a JSON status summary to stdout, and exits 0 on success or 1 on failure. This is a diagnostic mode, not a runtime mode — it's fine to use stdout here because no MCP server is being spawned.

**ADR-006 amendment**: Add `MCP_BIN_CHECK` env var. When set to `1`, run in diagnostic mode (verify manifest, signature, cache, platform) without executing the binary. Output status to stdout as JSON. No CLI flags added.

---

## Summary

| Conflict | Verdict | Action |
|----------|---------|--------|
| ADR-010 (denylist) | Modify | Add `MCP_BIN_ALLOW_ENV` escape hatch. Do NOT expand denylist patterns. |
| ADR-004 (signing) | Uphold | Ship with Ed25519 signing. Non-negotiable for arbitrary code execution. |
| ADR-006 (no CLI flags) | Modify | Add `MCP_BIN_CHECK=1` env var for diagnostics. No CLI flags. |
