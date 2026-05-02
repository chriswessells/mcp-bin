# Patch: T2 — Cut Windows/zip, Reduce Platforms

Fixes: H10 (dual archive format), H16 (5 platforms → 2)

---

## Change 1: R2 — Remove darwin-x64 and win32-x64 from platform list

**Old text:**
```
- R2: Detect the current platform (`darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`).
```

**New text:**
```
- R2: Detect the current platform (`darwin-arm64`, `linux-x64`, `linux-arm64`).
```

---

## Change 2: R7 — Remove .zip support, tar.gz only

**Old text:**
```
- R7: Extract the binary from the archive (supports `.tar.gz` and `.zip`).
```

**New text:**
```
- R7: Extract the binary from the archive (`.tar.gz` format only).
```

---

## Change 3: R8 — Clarify Unix-only

**Old text:**
```
- R8: Set the binary as executable (`chmod +x`).
```

**New text:**
```
- R8: Set the binary as executable (`chmod +x`) on Unix systems.
```

---

## Change 4: R17 — Remove win32-x64 and darwin-x64 from platform identifiers

**Old text:**
```
- R17: Platform identifiers use Node.js conventions: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`.
```

**New text:**
```
- R17: Platform identifiers use Node.js conventions: `darwin-arm64`, `linux-x64`, `linux-arm64`.
```

---

## Change 5: Add NR6 — Windows not supported in v1

**Old text:**
```
- NR3: The runner does not auto-update. Version is explicit in the registry entry.
```

**New text:**
```
- NR3: The runner does not auto-update. Version is explicit in the registry entry.
- NR6: Windows is not supported in v1. The platform schema allows adding `win32-x64` in a future version.
```

---

## Change 6: Remove win32-x64 from manifest schema example in R16

**Old text:**
```
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
```

**New text:**
```
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
  Supported `<platform>` values: `darwin-arm64`, `linux-x64`, `linux-arm64`.
```
