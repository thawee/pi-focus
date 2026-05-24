#!/bin/bash
# ⚡ build.sh — Compiles TypeScript extensions to JavaScript

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "\n\x1b[32m⚡ Building pi-focus extensions...\x1b[0m"

# 1. Compile TypeScript extensions
echo -e "\n\x1b[34m[1/1] Compiling TypeScript extensions to JavaScript...\x1b[0m"
cd "$PROJECT_DIR"
npx tsc

echo -e "\n\x1b[32m✔ Build complete!\x1b[0m"
