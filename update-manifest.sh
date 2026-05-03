#!/bin/bash
set -eo pipefail

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

echo "Updated manifest.json for $SERVER@$VERSION"
