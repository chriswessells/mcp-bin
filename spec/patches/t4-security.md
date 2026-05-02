# Patch: T4 — Security Hardening

Fixes: C1 (manifest signing), C2 (TOCTOU), H4 (env var injection), H5 (path traversal in tar), H6 (binary_name validation), H17 (env leakage)

Depends on: T2 (tar.gz only, Unix only)

---

## Insertion Point: After S6 in the "## Security" section

**Add after:**
```
- S6: Temporary files must be cleaned up on failure.
```

**New entries:**
```
- S7: The manifest must be signed. The runner must verify the signature before trusting any URL or checksum. The signing public key is pinned in the runner package. Signature format: detached Ed25519 signature file at `<manifest-url>.sig`.
- S8: Validate that `binary_name` in the manifest contains only alphanumeric characters, hyphens, and underscores. Reject values containing `/`, `\`, `..`, or null bytes.
- S9: During tar.gz extraction, validate that all extracted paths resolve within the target cache directory. Reject archives containing absolute paths, `..` components, or symlinks pointing outside the cache directory.
- S10: Log a warning to stderr when using a non-default manifest URL via `MCP_BIN_MANIFEST_URL`.
- S11: Sanitize URLs in error messages — strip query parameters before printing to prevent credential leakage (e.g., presigned URL tokens).
- S12: The runner must not forward sensitive environment variables (`AWS_*`, `GITHUB_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`) to the child process unless explicitly listed in the manifest's `environmentVariables` array for that server.
```

---

## Insertion Point: After E7 (or E9 if T5 patch applied first) in the "## Error Handling" section

**Add after the last existing error entry:**

**New entries:**
```
- E10: Manifest signature verification failed → exit 1, stderr: "Manifest signature verification failed. The manifest may have been tampered with."
- E11: Invalid binary_name → exit 1, stderr: "Invalid binary name '<name>' in manifest — must contain only alphanumeric characters, hyphens, and underscores."
- E12: Archive path traversal detected → exit 1, stderr: "Archive contains unsafe paths. Extraction aborted."
```
