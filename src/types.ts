/** Manifest schema as fetched from the registry */
export interface Manifest {
  schema_version: number;
  servers: Record<string, Record<string, Record<string, PlatformEntry>>>;
}

export interface PlatformEntry {
  url: string;
  sha256: string;
  binary_name?: string;
}

/** Resolved entry for a specific server+version+platform */
export interface ServerEntry {
  url: string;
  sha256: string;
  binaryName: string;
}

/** Result of a cache lookup */
export type CacheLookupResult =
  | { hit: true; binaryPath: string }
  | { hit: false };

/** Platform identifier */
export type Platform = "darwin-arm64" | "linux-x64" | "linux-arm64";
