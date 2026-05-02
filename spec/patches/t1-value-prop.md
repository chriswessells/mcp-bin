# T1 Patch: Value Proposition & Quickstart

## Patch 1 — Before/After in Problem section

INSERT AFTER the last paragraph of `## Problem` section (after "...automatic versioning, caching, or platform detection."):

```markdown
- **Before**: Users must manually download, extract, chmod, and configure the binary path.
- **After**: Users add one JSON block to their config. The runner handles everything.
```

---

## Patch 2 — Value Proposition section

INSERT AFTER `## Problem` section (before `## Goal`):

```markdown
## Value Proposition

Ship your Rust (or any native binary) MCP server to any Kiro user with zero manual installation.
One npx command. Automatic platform detection, SHA256 verification, and local caching.
```

---

## Patch 3 — Quickstart Example section

INSERT AFTER `## Components` heading and its description (before `### 1. Runner`):

```markdown
## Quickstart Example

### Server Author

You maintain `my-server` on GitHub with release binaries. Here's what you do:

1. Add your server to the manifest JSON:

   ```json
   {
     "servers": {
       "my-server": {
         "1.0.0": {
           "darwin-arm64": {
             "url": "https://github.com/you/my-server/releases/download/v1.0.0/my-server-darwin-arm64.tar.gz",
             "sha256": "a1b2c3...",
             "binary_name": "my-server"
           },
           "linux-x64": {
             "url": "https://github.com/you/my-server/releases/download/v1.0.0/my-server-linux-x64.tar.gz",
             "sha256": "d4e5f6...",
             "binary_name": "my-server"
           }
         }
       }
     }
   }
   ```

2. Host the manifest at a public HTTPS URL (or submit to the default registry).

### End User

A Kiro user adds your server to their agent config:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@mcp-bin/runner", "my-server", "1.0.0"]
    }
  }
}
```

First run downloads the binary (~5s). Subsequent runs use the cache (<100ms).
```
