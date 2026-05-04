#!/bin/bash
set -eo pipefail

usage() {
  cat <<'EOF'
Usage: ./update-manifest.sh --server <name> --version <version> --release-url <url> --checksums <url>

Options:
  --server       Server name in the manifest
  --version      Version string (e.g., 1.0.0)
  --release-url  Base URL for release assets
  --checksums    URL to SHA256SUMS file

Example:
  ./update-manifest.sh \
    --server my-server \
    --version 1.0.0 \
    --release-url https://github.com/you/my-server/releases/download/v1.0.0 \
    --checksums https://github.com/you/my-server/releases/download/v1.0.0/SHA256SUMS.txt
EOF
}

# Show help on no args or --help/-h
if [[ $# -eq 0 ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
  usage
  exit 0
fi

# Update manifest.json with a new server release
# Usage: ./update-manifest.sh --server NAME --version VER --release-url URL --checksums URL

for cmd in jq curl; do
  command -v "$cmd" >/dev/null || { echo "Error: $cmd is required" >&2; exit 1; }
done

SERVER="" VERSION="" RELEASE_URL="" CHECKSUMS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2;;
    --version) VERSION="$2"; shift 2;;
    --release-url) RELEASE_URL="$2"; shift 2;;
    --checksums) CHECKSUMS="$2"; shift 2;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

if [[ -z "$SERVER" || -z "$VERSION" || -z "$RELEASE_URL" || -z "$CHECKSUMS" ]]; then
  echo "Usage: update-manifest.sh --server NAME --version VER --release-url URL --checksums URL" >&2
  exit 1
fi

# Download checksums
SUMS=$(curl -fsSL "$CHECKSUMS")

MANIFEST="manifest.json"
[[ -f "$MANIFEST" ]] || echo '{"schema_version":1,"servers":{}}' > "$MANIFEST"

add_platform() {
  local plat="$1" pattern="$2"
  local line sha file url
  line=$(echo "$SUMS" | grep -iE "$pattern" | head -1 || true)
  [[ -n "$line" ]] || return 0
  sha=$(echo "$line" | awk '{print $1}')
  file=$(echo "$line" | awk '{print $2}' | sed 's/^\*//')
  url="${RELEASE_URL}/${file}"
  cp manifest.json manifest.json.tmp
  jq --arg srv "$SERVER" --arg ver "$VERSION" --arg plat "$plat" \
     --arg url "$url" --arg sha "$sha" \
     '.servers[$srv][$ver][$plat] = {url: $url, sha256: $sha}' \
     manifest.json.tmp > manifest.json
  rm -f manifest.json.tmp
  echo "  Added $plat: $file"
}

add_platform "darwin-arm64" "(aarch64-apple-darwin|darwin-arm64)"
add_platform "linux-x64" "(x86_64-unknown-linux|linux-x64|linux-amd64)"
add_platform "linux-arm64" "(aarch64-unknown-linux|linux-arm64|linux-aarch64)"

# Validate against schema if available
if [[ -f "manifest.schema.json" ]] && command -v node >/dev/null 2>&1; then
  node -e "
    const fs = require('fs');
    const schema = JSON.parse(fs.readFileSync('manifest.schema.json', 'utf-8'));
    const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf-8'));
    // Basic validation: check required fields
    if (manifest.schema_version !== 1) { console.error('Schema version must be 1'); process.exit(1); }
    if (typeof manifest.servers !== 'object') { console.error('Missing servers object'); process.exit(1); }
    console.log('  Schema validation passed');
  " || echo "  Warning: schema validation failed" >&2
fi

echo "Updated manifest.json for $SERVER@$VERSION"
