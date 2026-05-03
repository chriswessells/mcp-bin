# Roadmap — mcp-bin

## v1.0 — Single-operator registry (current)

Ship a working runner that downloads, caches, and executes native binary MCP servers via `npx`. Single manifest signed by a single key holder.

- npm package `@mcp-bin/runner`
- Platforms: darwin-arm64, linux-x64, linux-arm64
- Ed25519 manifest signing with pinned public key
- SHA256 archive verification + sidecar cache integrity
- Atomic cache with file locking
- Shell script for manifest updates (`update-manifest.sh`)
- Default manifest hosted on GitHub Pages

**Who can use it**: Any MCP server author who submits to the default manifest (signed by the operator), or anyone who self-hosts their own manifest + fork of the runner with their own signing key.

**Limitation**: Third-party authors cannot publish independently — they must submit entries to the manifest operator for signing, or self-host everything.

---

## v1.x — Community onboarding

Lower the barrier for third-party server authors without changing the trust model.

- `CONTRIBUTING.md` with manifest submission process
- JSON schema for manifest validation
- GitHub PR template with CI validation (lint manifest, verify checksums exist)
- `latest` version alias in manifest (F1)
- Cache eviction policy (F2)
- `MCP_BIN_VERBOSE=1` debug logging (F5)
- Competitive positioning in README ("Why not Docker/cargo-binstall?")
- WSL2 compatibility documentation

---

## v2.0 — Standalone binary runner

Remove the Node.js dependency. The runner itself becomes a native binary, distributed via `curl | sh`, Homebrew, or direct download.

- Standalone runner binary (Rust or Go) — no npm/npx required (P1)
- Homebrew tap for macOS
- Install script for Linux
- Kiro registry integration via new `registryType` (or shim)
- Same manifest format, same cache layout, same verification chain

**Why this matters**: The primary audience is Rust developers who may not have Node.js. v2 eliminates the most significant adoption barrier.

---

## v3.0 — Multi-publisher registry

Decentralize the trust model so any server author can sign their own manifest entries independently.

- Per-entry signatures: each server author signs their own `{server, version, platform}` entries with their own Ed25519 key
- Author public keys registered in the manifest (or a separate keyring)
- Transparency log integration (Sigstore/cosign) for audit trail
- `mcp-bin publish` CLI for server authors to sign and submit entries from CI
- GitHub Action for automated manifest updates on release
- Multiple manifest sources (federation) — runner can merge entries from multiple registries

**Who can use it**: Any company or individual can independently publish and sign their own MCP server binaries. Users choose which authors to trust. No central gatekeeper.

---

## Future considerations

- Windows support: `win32-x64` platform, `.zip` archives, `.exe` handling (ADR-003 deferred)
- Additional signing algorithms: GPG, cosign (F3)
- Private registries with authentication (presigned URLs, token-based access)
- Binary reproducibility verification (compare builds across independent builders)
- Language-agnostic framing: the runner works for any compiled language (Go, C++, Zig), not just Rust
