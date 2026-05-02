# T3 Patch: Replace Author Tooling with Script

**Fixes**: C6 (premature tooling), H11 (doubles maintenance), H14 (underspecified)

---

## Change 1: Replace "### 3. Server Author Integration" section

### OLD TEXT

```markdown
### 3. Server Author Integration

How a Rust MCP server author registers their server in the manifest.

#### Requirements

- R21: Provide a CLI tool or GitHub Action that updates the manifest after a release.
- R22: Input: server name, version, GitHub Release URL pattern, SHA256SUMS file URL.
- R23: Output: updated manifest JSON with entries for all platforms found in the release.
- R24: The tool should be idempotent — running it twice with the same input produces the same output.
```

### NEW TEXT

```markdown
### 3. Server Author Integration

How a Rust MCP server author registers their server in the manifest.

#### Requirements

- R21: Provide a shell script (`update-manifest.sh`) that updates the manifest JSON after a release.
- R22: Input: server name, version, GitHub Release URL base, SHA256SUMS file URL.
- R23: Output: updated manifest JSON with entries for all platforms found in the release.
- R24: The script should be idempotent — running it twice with the same input produces the same output.
- R25: A generic CLI tool or GitHub Action for third-party authors is deferred to a future version.

#### Example usage

```
./update-manifest.sh \
  --server local-memory-mcp \
  --version 0.2.1 \
  --release-url https://github.com/chriswessells/local-memory-mcp/releases/download/v0.2.1 \
  --checksums https://github.com/chriswessells/local-memory-mcp/releases/download/v0.2.1/SHA256SUMS.txt
```
```

---

## Change 2: Renumber subsequent requirements (R25→R26, R26→R27, R27→R28, R28→R29, R29→R30)

### OLD TEXT

```markdown
#### Requirements

- R25: Each server entry in the Kiro registry uses `registryType: "npm"` with `identifier: "@mcp-bin/runner"`.
- R26: Server name and version are passed via `packageArguments`.
- R27: Custom manifest URL (if not using the default) is passed via `environmentVariables`.
- R28: Example registry entry:
```

### NEW TEXT

```markdown
#### Requirements

- R26: Each server entry in the Kiro registry uses `registryType: "npm"` with `identifier: "@mcp-bin/runner"`.
- R27: Server name and version are passed via `packageArguments`.
- R28: Custom manifest URL (if not using the default) is passed via `environmentVariables`.
- R29: Example registry entry:
```

---

### OLD TEXT

```markdown
#### Requirements

- R29: Equivalent local config:
```

### NEW TEXT

```markdown
#### Requirements

- R30: Equivalent local config:
```
