# T7: Simplify Config & Elevate F5 — Patch

## Change 1: R12

**Old text:**
```
- R12: Support a `--manifest-url` flag or `MCP_BIN_MANIFEST_URL` environment variable to override the default manifest location.
```

**New text:**
```
- R12: Support `MCP_BIN_MANIFEST_URL` environment variable to override the default manifest location.
```

## Change 2: R13

**Old text:**
```
- R13: Support a `--cache-dir` flag or `MCP_BIN_CACHE_DIR` environment variable to override the default cache location.
```

**New text:**
```
- R13: Support `MCP_BIN_CACHE_DIR` environment variable to override the default cache location.
```

## Change 3: Future Considerations — Add Phase 2 section and restructure

**Old text:**
```
## Future Considerations

- F1: Support `latest` as a version alias that resolves via the manifest.
- F2: Cache eviction policy (e.g., keep last N versions).
- F3: Signature verification (GPG or cosign) in addition to SHA256.
- F4: A `mcp-bin publish` CLI that server authors run in CI to update the manifest.
- F5: Support for the runner itself to be distributed as a standalone binary (removing the npm/npx dependency).
```

**New text:**
```
## Phase 2 — Planned

- P1: Distribute the runner as a standalone binary, removing the npm/npx dependency. This addresses the adoption barrier for users without Node.js.

## Future Considerations

- F1: Support `latest` as a version alias that resolves via the manifest.
- F2: Cache eviction policy (e.g., keep last N versions).
- F3: Signature verification (GPG or cosign) in addition to SHA256.
- F4: A `mcp-bin publish` CLI that server authors run in CI to update the manifest.
- F5: Support `--verbose` or `MCP_BIN_VERBOSE=1` for debug logging to stderr.
```
