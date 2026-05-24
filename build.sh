#!/bin/bash
# ⚡ build.sh — Compiles TypeScript extensions to JavaScript

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "\n\x1b[32m⚡ Building pi-focus extensions...\x1b[0m"

# 1. Compile TypeScript extensions
echo -e "\n\x1b[34m[1/2] Compiling TypeScript extensions to JavaScript...\x1b[0m"
cd "$PROJECT_DIR"
npx tsc

# 2. Copy and adapt package.json files for distribution
echo -e "\n\x1b[34m[2/2] Generating package.json manifests in dist/...\x1b[0m"
    mkdir -p dist/focus-mode dist/focus-tools-optimizer
    
    # Generate dist/focus-mode/package.json
    cat <<EOF > dist/focus-mode/package.json
    {
      "name": "focus-mode",
      "version": "1.1.0",
      "description": "In-process State Machine Orchestrator for Pi Agent",
      "main": "index.js",
      "type": "commonjs",
      "pi": {
        "extensions": ["./index.js"]
      }
    }
    EOF
    
    # Generate dist/focus-tools-optimizer/package.json
    cat <<EOF > dist/focus-tools-optimizer/package.json
    {
      "name": "focus-tools-optimizer",
      "version": "1.1.0",
      "description": "Zero-token weighted regex category intent classifier and schema pruner",
      "main": "index.js",
      "type": "commonjs",
      "pi": {
        "extensions": ["./index.js"]
      }
    }
EOF

echo -e "\n\x1b[32m✔ Build complete!\x1b[0m"

