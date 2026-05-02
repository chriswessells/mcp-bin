# mcp-bin — Requirements Specification

## Problem

Kiro's MCP registry supports distributing MCP servers via `npm`, `pypi`, and `oci` package runners. There is no distribution path for compiled Rust (or other native binary) MCP servers. Server authors must rely on manual installation (`install.sh`, `cargo install`, direct binary download) which doesn't integrate with the enterprise MCP registry allowlist or provide automatic versioning, caching, or platform detection.

## Goal

A generic npm-based runner that downloads, caches, and executes prebuilt native MCP server binaries. It plugs into Kiro's existing MCP registry infrastructure by using `registryType: "npm"`, requiring no changes to Kiro itself.

## Architecture

```
Kiro MCP Registry (enterprise allowlist JSON)
    ↓ references @mcp-bin/runner via registryType: "npm"
npx @mcp-bin/runner <server-name> <version>
    ↓ reads manifest
Manifest Registry (hosted JSON — S3, GitHub Pages, etc.)
    ↓ resolves {server-name, version, platform} → URL + checksum
GitHub Releases (prebuilt binaries)
    ↓ downloads, verifies, caches
~/.cache/mcp-bin/<server-name>/<version>/<binary>
    ↓ exec with stdio inherited
Native MCP server running
```

## Components

### 1. Runner (`@mcp-bin/runner`)

An npm package that acts as a shim between Kiro and native MCP server binaries.

#### Requirements

- R1: Accept server name and version as positional CLI arguments.
- R2: Detect the current platform (`darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`).
- R3: Fetch the manifest registry to resolve the download URL and SHA256 checksum for the given server, version, and platform.
- R4: Check the local cache (`~/.cache/mcp-bin/<server>/<version>/<binary>`) before downloading.
- R5: Download the binary archive from the resolved URL if not cached.
- R6: Verify the SHA256 checksum of the downloaded archive before extraction.
- R7: Extract the binary from the archive (supports `.tar.gz` and `.zip`).
- R8: Set the binary as executable (`chmod +x`).
- R9: Exec the binary with stdio inherited (stdin/stdout/stderr pass through for MCP stdio transport).
- R10: Exit with the same exit code as the child process.
- R11: Print errors to stderr only (stdout is reserved for MCP protocol traffic).
- R12: Support a `--manifest-url` flag or `MCP_BIN_MANIFEST_URL` environment variable to override the default manifest location.
- R13: Support a `--cache-dir` flag or `MCP_BIN_CACHE_DIR` environment variable to override the default cache location.
- R14: Forward any additional arguments after server name and version to the binary.

#### Non-requirements

- NR1: The runner does not compile anything. It only downloads prebuilt binaries.
- NR2: The runner does not manage Rust toolchains or cargo.
- NR3: The runner does not auto-update. Version is explicit in the registry entry.

### 2. Manifest Registry

A JSON file that maps `{server, version, platform}` to a download URL and checksum.

#### Requirements

- R15: Hosted as a static JSON file over HTTPS (S3, GitHub Pages, any web server).
- R16: Schema:
  ```json
  {
    "servers": {
      "<server-name>": {
        "<version>": {
          "<platform>": {
            "url": "https://...",
            "sha256": "abc123...",
            "binary_name": "local-memory-mcp"
          }
        }
      }
    }
  }
  ```
- R17: Platform identifiers use Node.js conventions: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`.
- R18: `binary_name` is optional. Defaults to the server name.
- R19: `url` points to a `.tar.gz` or `.zip` archive containing the binary.
- R20: `sha256` is the checksum of the archive file (not the extracted binary).

#### Non-requirements

- NR4: The manifest does not need a database or API. It is a static file.
- NR5: The manifest does not handle authentication. If private, use S3 presigned URLs or a private web server.

### 3. Server Author Integration

How a Rust MCP server author registers their server in the manifest.

#### Requirements

- R21: Provide a CLI tool or GitHub Action that updates the manifest after a release.
- R22: Input: server name, version, GitHub Release URL pattern, SHA256SUMS file URL.
- R23: Output: updated manifest JSON with entries for all platforms found in the release.
- R24: The tool should be idempotent — running it twice with the same input produces the same output.

### 4. Kiro MCP Registry Integration

How the runner appears in a Kiro enterprise MCP registry.

#### Requirements

- R25: Each server entry in the Kiro registry uses `registryType: "npm"` with `identifier: "@mcp-bin/runner"`.
- R26: Server name and version are passed via `packageArguments`.
- R27: Custom manifest URL (if not using the default) is passed via `environmentVariables`.
- R28: Example registry entry:
  ```json
  {
    "server": {
      "name": "local-memory-mcp",
      "description": "Local agent memory MCP server",
      "version": "0.2.1",
      "packages": [{
        "registryType": "npm",
        "identifier": "@mcp-bin/runner",
        "transport": { "type": "stdio" },
        "packageArguments": [
          { "type": "positional", "value": "local-memory-mcp" },
          { "type": "positional", "value": "0.2.1" }
        ],
        "environmentVariables": [
          { "name": "MCP_BIN_MANIFEST_URL", "value": "https://mcp-bin.example.com/manifest.json" }
        ]
      }]
    }
  }
  ```

### 5. Local Agent Config Integration

How the runner appears in a user's local `mcp.json` or agent config.

#### Requirements

- R29: Equivalent local config:
  ```json
  {
    "mcpServers": {
      "local-memory-mcp": {
        "command": "npx",
        "args": ["-y", "@mcp-bin/runner", "local-memory-mcp", "0.2.1"]
      }
    }
  }
  ```

## Security

- S1: All downloads must be over HTTPS.
- S2: SHA256 checksum verification is mandatory. Fail hard on mismatch.
- S3: The manifest URL must be HTTPS (or `file://` for local testing).
- S4: Downloaded archives are extracted to a user-scoped cache directory, not a system directory.
- S5: The runner must not execute anything other than the verified, extracted binary.
- S6: Temporary files must be cleaned up on failure.

## Error Handling

- E1: Missing server in manifest → exit 1, stderr: "Server '<name>' not found in manifest"
- E2: Missing version → exit 1, stderr: "Version '<version>' of '<name>' not found"
- E3: Missing platform → exit 1, stderr: "No binary available for platform '<platform>'"
- E4: Download failure → exit 1, stderr: "Failed to download: <url>"
- E5: Checksum mismatch → exit 1, stderr: "Checksum verification failed for '<name>' v<version>"
- E6: Manifest fetch failure → exit 1, stderr: "Failed to fetch manifest: <url>"
- E7: All errors go to stderr. Stdout is never used for error output.

## Testing

- T1: Unit tests for platform detection, cache path resolution, checksum verification.
- T2: Integration test: mock manifest + mock HTTP server → runner downloads, caches, and execs a test binary.
- T3: Cache hit test: second run uses cache, no HTTP requests.
- T4: Checksum mismatch test: tampered archive is rejected.
- T5: Missing platform test: appropriate error message.

## Future Considerations

- F1: Support `latest` as a version alias that resolves via the manifest.
- F2: Cache eviction policy (e.g., keep last N versions).
- F3: Signature verification (GPG or cosign) in addition to SHA256.
- F4: A `mcp-bin publish` CLI that server authors run in CI to update the manifest.
- F5: Support for the runner itself to be distributed as a standalone binary (removing the npm/npx dependency).
