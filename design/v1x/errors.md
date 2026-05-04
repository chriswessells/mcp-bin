# v1.x Error Classes

## Overview

Two new error classes in `src/errors.ts`, following the existing pattern.

## E16: InvalidPublicKeyError

```typescript
/** E16: Invalid MCP_BIN_PUBLIC_KEY */
export class InvalidPublicKeyError extends McpBinError {
  constructor() {
    super(
      "Invalid MCP_BIN_PUBLIC_KEY: expected base64-encoded Ed25519 DER SPKI public key.\n" +
      "Extract with: openssl pkey -in your-key.pem -pubout -outform DER | base64 | tr -d '\\n'",
      "E16"
    );
  }
}
```

- Thrown by: `ManifestClient` constructor when public key validation fails
- Caught by: `cli.ts` to format user-facing message and exit 1
- Note: The error message itself contains the extraction command hint (C1.4, finding #11)
- Note: The `tr -d '\n'` in the extraction command is always required — most base64 implementations wrap output (not just macOS). GNU coreutils `base64` also wraps at 76 characters by default.

## E17: NoStableVersionsError

```typescript
/** E17: No stable versions for latest resolution */
export class NoStableVersionsError extends McpBinError {
  constructor(serverName: string) {
    super(`No stable versions found for '${serverName}'`, "E17");
  }
}
```

- Thrown by: `resolveLatest()` in `manifest-client.ts`
- Caught by: `main().catch()` in `cli.ts` (existing McpBinError handler)
- The error message matches the spec exactly: `"No stable versions found for '<server>'"`

## Placement

Add both classes at the end of `src/errors.ts`, before the closing of the file, after the existing `DiskFullError` class. Follow the existing pattern of JSDoc comment with error code.
