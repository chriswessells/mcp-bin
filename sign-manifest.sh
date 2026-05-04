#!/bin/bash
set -euo pipefail

# Sign a manifest.json with the Ed25519 private key
# Usage: ./sign-manifest.sh <manifest.json> [private-key.pem]

MANIFEST="${1:?Usage: sign-manifest.sh <manifest.json> [private-key.pem]}"
KEY="${2:-keys/manifest-signing.pem}"

if [ ! -f "$MANIFEST" ]; then
  echo "Error: $MANIFEST not found" >&2
  exit 1
fi
if [ ! -f "$KEY" ]; then
  echo "Error: $KEY not found" >&2
  exit 1
fi

_MCP_MANIFEST="$MANIFEST" _MCP_KEY="$KEY" node -e "
const crypto = require('crypto');
const fs = require('fs');
const manifest = fs.readFileSync(process.env._MCP_MANIFEST);
const key = fs.readFileSync(process.env._MCP_KEY, 'utf-8');
const privateKey = crypto.createPrivateKey(key);
const sig = crypto.sign(null, manifest, privateKey);
fs.writeFileSync(process.env._MCP_MANIFEST + '.sig', sig);
console.log('Signed: ' + process.env._MCP_MANIFEST + '.sig (' + sig.length + ' bytes)');
"
