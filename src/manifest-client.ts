import { verify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Manifest, Platform, ServerEntry } from "./types.js";
import {
  ManifestFetchError,
  SignatureVerificationError,
  SignatureNotFoundError,
  SchemaVersionError,
  ServerNotFoundError,
  VersionNotFoundError,
  PlatformNotFoundError,
} from "./errors.js";

const DEFAULT_MANIFEST_URL =
  "https://chriswessells.github.io/mcp-bin/manifest.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 30_000;

// T9-PLACEHOLDER: Replace with real Ed25519 public key in DER SPKI format
const DEFAULT_PUBLIC_KEY = Buffer.alloc(44); // 44 bytes = DER SPKI wrapper (12) + 32 zero bytes

export interface ManifestClientConfig {
  manifestUrl: string;
  cacheDir: string;
  publicKey: Buffer;
}

export interface FetchResult {
  manifest: Manifest;
  warnings: string[];
}

function verifySignature(
  data: Buffer,
  sig: Buffer,
  publicKey: Buffer
): boolean {
  try {
    return verify(
      null,
      data,
      { key: publicKey, format: "der", type: "spki" },
      sig
    );
  } catch {
    return false;
  }
}

function validateUrl(url: string): void {
  const allowFile = process.env.MCP_BIN_ALLOW_FILE_PROTOCOL === "1";
  if (url.startsWith("https://")) return;
  if (allowFile && url.startsWith("file://")) return;
  throw new ManifestFetchError(url);
}

function validateManifest(parsed: unknown): Manifest {
  const m = parsed as Record<string, unknown>;
  if (
    typeof m !== "object" ||
    m === null ||
    typeof m.schema_version !== "number"
  ) {
    throw new ManifestFetchError("Invalid manifest structure");
  }
  if (m.schema_version !== 1) throw new SchemaVersionError(m.schema_version);
  if (
    typeof m.servers !== "object" ||
    m.servers === null ||
    Array.isArray(m.servers)
  ) {
    throw new ManifestFetchError("Invalid manifest structure");
  }
  return m as unknown as Manifest;
}

async function fetchWithTimeout(
  url: string,
  signal: AbortSignal
): Promise<Response> {
  return fetch(url, { signal });
}

export class ManifestClient {
  private config: ManifestClientConfig;
  private manifestDir: string;
  private manifestPath: string;
  private sigPath: string;
  private metaPath: string;

  constructor(config: Partial<ManifestClientConfig> & { cacheDir: string }) {
    this.config = {
      manifestUrl: config.manifestUrl ?? DEFAULT_MANIFEST_URL,
      cacheDir: config.cacheDir,
      publicKey: config.publicKey ?? DEFAULT_PUBLIC_KEY,
    };
    this.manifestDir = path.join(this.config.cacheDir, ".manifest");
    this.manifestPath = path.join(this.manifestDir, "manifest.json");
    this.sigPath = path.join(this.manifestDir, "manifest.json.sig");
    this.metaPath = path.join(this.manifestDir, "manifest.json.meta");
  }

  async fetch(): Promise<FetchResult> {
    const warnings: string[] = [];
    const { manifestUrl, publicKey } = this.config;

    if (publicKey.every((b) => b === 0)) {
      throw new Error(
        "Ed25519 public key not configured — replace the placeholder before release"
      );
    }

    validateUrl(manifestUrl);

    if (
      manifestUrl !== DEFAULT_MANIFEST_URL &&
      process.env.MCP_BIN_ALLOW_FILE_PROTOCOL === "1" &&
      manifestUrl.startsWith("file://")
    ) {
      warnings.push(
        "Warning: file:// protocol enabled for manifest. Do not use in production."
      );
    }
    if (manifestUrl !== DEFAULT_MANIFEST_URL) {
      warnings.push(
        `Warning: using non-default manifest URL: ${manifestUrl}`
      );
    }

    // Check cache freshness
    const cached = await this.readCache();
    if (cached) {
      let fresh = false;
      try {
        const meta = JSON.parse(
          await fs.readFile(this.metaPath, "utf-8")
        );
        fresh = Date.now() - new Date(meta.fetchedAt).getTime() < CACHE_TTL_MS;
      } catch {
        // Corrupt meta — treat as stale (self-healing)
      }
      if (fresh) {
        if (verifySignature(cached.manifest, cached.sig, publicKey)) {
          return {
            manifest: validateManifest(JSON.parse(cached.manifest.toString())),
            warnings,
          };
        }
        // Sig failed on cache — fall through to re-fetch
      }
    }

    // Fetch manifest + sig
    let manifestBytes: Buffer;
    let sigBytes: Buffer;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), RESPONSE_TIMEOUT_MS);
      const resp = await fetchWithTimeout(manifestUrl, ac.signal);
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      manifestBytes = Buffer.from(await resp.arrayBuffer());
    } catch {
      // Fetch failed — try fallback
      return this.fallback(publicKey, manifestUrl, warnings);
    }

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), RESPONSE_TIMEOUT_MS);
      const resp = await fetchWithTimeout(manifestUrl + ".sig", ac.signal);
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      sigBytes = Buffer.from(await resp.arrayBuffer());
    } catch {
      // .sig fetch failed — only accept cached sig if manifest content matches
      if (cached?.sig && cached.manifest.equals(manifestBytes)) {
        sigBytes = cached.sig;
        warnings.push("Warning: using cached signature file");
      } else {
        throw new SignatureNotFoundError(manifestUrl);
      }
    }

    if (!verifySignature(manifestBytes, sigBytes, publicKey)) {
      throw new SignatureVerificationError();
    }

    const manifest = validateManifest(JSON.parse(manifestBytes.toString()));

    // Write cache atomically
    await this.writeCache(manifestBytes, sigBytes);

    return { manifest, warnings };
  }

  resolve(
    manifest: Manifest,
    serverName: string,
    version: string,
    platform: Platform
  ): ServerEntry {
    const server = manifest.servers[serverName];
    if (!server) throw new ServerNotFoundError(serverName);
    const ver = server[version];
    if (!ver) throw new VersionNotFoundError(version, serverName);
    const entry = ver[platform];
    if (!entry) throw new PlatformNotFoundError(platform);
    return {
      url: entry.url,
      sha256: entry.sha256,
      binaryName: entry.binary_name ?? serverName,
    };
  }

  private async readCache(): Promise<{
    manifest: Buffer;
    sig: Buffer;
  } | null> {
    try {
      const [manifest, sig] = await Promise.all([
        fs.readFile(this.manifestPath),
        fs.readFile(this.sigPath),
      ]);
      return { manifest, sig };
    } catch {
      return null;
    }
  }

  private async fallback(
    publicKey: Buffer,
    manifestUrl: string,
    warnings: string[]
  ): Promise<FetchResult> {
    const cached = await this.readCache();
    if (!cached) throw new ManifestFetchError(manifestUrl);
    if (!verifySignature(cached.manifest, cached.sig, publicKey)) {
      throw new SignatureVerificationError();
    }
    const manifest = validateManifest(
      JSON.parse(cached.manifest.toString())
    );
    warnings.push(
      "Warning: using cached manifest (fetch failed)"
    );
    return { manifest, warnings };
  }

  private async writeCache(
    manifestBytes: Buffer,
    sigBytes: Buffer
  ): Promise<void> {
    try {
      await fs.mkdir(this.manifestDir, { recursive: true });
      const tmpManifest = this.manifestPath + ".tmp";
      const tmpSig = this.sigPath + ".tmp";
      const tmpMeta = this.metaPath + ".tmp";
      const meta = JSON.stringify({ fetchedAt: new Date().toISOString() });
      await Promise.all([
        fs.writeFile(tmpManifest, manifestBytes),
        fs.writeFile(tmpSig, sigBytes),
        fs.writeFile(tmpMeta, meta),
      ]);
      await fs.rename(tmpManifest, this.manifestPath);
      await fs.rename(tmpSig, this.sigPath);
      await fs.rename(tmpMeta, this.metaPath);
    } catch {
      // Cache write failure is non-fatal
    }
  }
}
