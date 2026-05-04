/** Strip query parameters from URLs to prevent credential leakage in error messages (S11) */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

export class McpBinError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code: string, exitCode: number = 1) {
    super(message);
    this.name = "McpBinError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** E1: Server not found in manifest */
export class ServerNotFoundError extends McpBinError {
  constructor(name: string) {
    super(`Server '${name}' not found in manifest`, "E1");
  }
}

/** E2: Version not found */
export class VersionNotFoundError extends McpBinError {
  constructor(version: string, name: string) {
    super(`Version '${version}' of '${name}' not found`, "E2");
  }
}

/** E3: Platform not available */
export class PlatformNotFoundError extends McpBinError {
  constructor(platform: string) {
    super(`No binary available for platform '${platform}'`, "E3");
  }
}

/** E4: Download failure */
export class DownloadError extends McpBinError {
  constructor(url: string) {
    super(`Failed to download: ${sanitizeUrl(url)}`, "E4");
  }
}

/** E5: Checksum mismatch */
export class ChecksumError extends McpBinError {
  constructor(name: string, version: string) {
    super(`Checksum verification failed for '${name}' v${version}`, "E5");
  }
}

/** E6: Manifest fetch failure */
export class ManifestFetchError extends McpBinError {
  constructor(url: string) {
    super(`Failed to fetch manifest: ${sanitizeUrl(url)}`, "E6");
  }
}

/** E8: Download timeout */
export class DownloadTimeoutError extends McpBinError {
  constructor(seconds: number, url: string) {
    super(`Download timed out after ${seconds}s: ${sanitizeUrl(url)}`, "E8");
  }
}

/** E9: All retries exhausted */
export class RetriesExhaustedError extends McpBinError {
  constructor(retries: number, url: string) {
    super(`Failed after ${retries} retries: ${sanitizeUrl(url)}`, "E9");
  }
}

/** E10: Manifest signature verification failed */
export class SignatureVerificationError extends McpBinError {
  constructor() {
    super(
      "Manifest signature verification failed. The manifest may have been tampered with.",
      "E10"
    );
  }
}

/** E11: Invalid binary name */
export class InvalidBinaryNameError extends McpBinError {
  constructor(name: string) {
    super(
      `Invalid binary name '${name}' in manifest — must contain only alphanumeric characters, hyphens, and underscores.`,
      "E11"
    );
  }
}

/** E12: Archive path traversal */
export class PathTraversalError extends McpBinError {
  constructor() {
    super("Archive contains unsafe paths. Extraction aborted.", "E12");
  }
}

/** E13: Unsupported manifest schema version */
export class SchemaVersionError extends McpBinError {
  constructor(version: number) {
    super(
      `Unsupported manifest schema version ${version}. Please update @mcp-bin/runner.`,
      "E13"
    );
  }
}

/** E14: Lock acquisition timeout */
export class LockTimeoutError extends McpBinError {
  constructor(server: string, version: string) {
    super(
      `Timed out waiting for lock on '${server}' v${version}. Another process may be downloading.`,
      "E14"
    );
  }
}

/** E15: Manifest signature file unavailable */
export class SignatureNotFoundError extends McpBinError {
  constructor(url: string) {
    super(`Manifest signature file not found at ${sanitizeUrl(url)}.sig`, "E15");
  }
}

/** Invalid argument (serverName/version validation) */
export class InvalidArgumentError extends McpBinError {
  constructor(message: string) {
    super(message, "EINVAL");
  }
}

/** Disk full (ENOSPC) */
export class DiskFullError extends McpBinError {
  constructor(path: string) {
    super(`Insufficient disk space in cache directory: ${path}`, "ENOSPC");
  }
}

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

/** E17: No stable versions for latest resolution */
export class NoStableVersionsError extends McpBinError {
  constructor(serverName: string) {
    super(`No stable versions found for '${serverName}'`, "E17");
  }
}