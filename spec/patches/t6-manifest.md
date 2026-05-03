# T6 Patch: Manifest Improvements

Fixes: H1 (monolithic manifest), H3 (no manifest caching), H13 (no default hosting location), H15 (no runner versioning)

---

## Change 1: Add `schema_version` to manifest schema example

**INSERT POINT**: In R16 schema (Section "2. Manifest Registry"), inside the JSON block, add `"schema_version"` as the first top-level field.

**Replace the R16 JSON with:**

```json
{
  "schema_version": 1,
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

---

## Change 2: Add schema version validation requirement

**INSERT POINT**: After R20 ("`sha256` is the checksum of the archive file"), add:

```
- R21: The manifest must include a top-level `"schema_version": 1` field. The runner must check this and exit 1 with stderr: "Unsupported manifest schema version <N>. Please update @mcp-bin/runner." if it encounters an unsupported version.
```

---

## Change 3: Add manifest caching requirement

**INSERT POINT**: After the new R21 above, add:

```
- R22: The runner must cache the manifest locally with a 1-hour TTL. On fetch failure, fall back to the last-known-good cached manifest with a warning to stderr: "Manifest fetch failed, using cached manifest (age: <duration>)."
```

---

## Change 4: Define default manifest URL

**INSERT POINT**: After the new R22 above, add:

```
- R23: The default manifest URL is `https://your-registry.example.com/manifest.json`. The `MCP_BIN_MANIFEST_URL` environment variable overrides this default.
```

---

## Change 5: Add runner versioning requirement

**INSERT POINT**: In Section "4. Kiro MCP Registry Integration", after R28, add:

```
- R29: The runner CLI interface (positional args, env vars) is a stable contract. Breaking changes require a major version bump. Registry entries should pin the runner version: `@mcp-bin/runner@1.x`.
```

---

## Change 6: Renumber subsequent requirements

All requirements after the original R20 shift by +3 due to new R21–R23:

| Original | New |
|----------|-----|
| R21 | R24 |
| R22 | R25 |
| R23 | R26 |
| R24 | R27 |
| R25 | R28 |
| R26 | R29 |
| R27 | R30 |
| R28 | R31 |
| R29 | R32 |

And the new runner versioning requirement (Change 5) becomes R32 (after the renumbered R31), making the local config requirement R33.

---

## Summary of new requirements added

| ID | Requirement |
|----|-------------|
| R21 (new) | Manifest `schema_version` field + runner validation |
| R22 (new) | Manifest caching with 1-hour TTL + fallback to stale cache |
| R23 (new) | Default manifest URL: `https://your-registry.example.com/manifest.json` |
| R32 (new) | Runner CLI stability contract + semver pinning |
