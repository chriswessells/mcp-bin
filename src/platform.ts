import os from "node:os";
import { PlatformNotFoundError } from "./errors.js";
import type { Platform } from "./types.js";

export function detectPlatform(): Platform {
  const arch = os.arch();
  const platform = os.platform();

  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";

  throw new PlatformNotFoundError(`${platform}-${arch}`);
}
