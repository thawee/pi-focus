#!/bin/bash
# ⚡ setup.sh — Installs and compiles pi-focus extensions

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_PI_DIR="$HOME/.pi/agent"

echo -e "\x1b[32m⚡ Setting up pi-focus extension suite...\x1b[0m"

# 1. Install local dependencies
echo -e "\n\x1b[34m[1/3] Installing devDependencies...\x1b[0m"
cd "$PROJECT_DIR"
npm install

# 2. Compile TypeScript extensions
echo -e "\n\x1b[34m[2/3] Compiling TypeScript extensions via build.sh...\x1b[0m"
./build.sh


# 3. Guide/Link integration
echo -e "\n\x1b[34m[3/3] Integrating with Pi Agent...\x1b[0m"

if [ -d "$GLOBAL_PI_DIR" ]; then
    echo -e "\x1b[32m✔ Found global Pi Agent directory at: $GLOBAL_PI_DIR\x1b[0m"
    
    # Clean up any old symlinks
    OLD_LINKS=("plan-tracker" "task-checklist" "pivot-handler")
    for old in "${OLD_LINKS[@]}"; do
        if [ -L "$GLOBAL_PI_DIR/extensions/$old" ] || [ -d "$GLOBAL_PI_DIR/extensions/$old" ]; then
            rm -rf "$GLOBAL_PI_DIR/extensions/$old"
            echo -e "  Dropped old symlink: $old"
        fi
    done

    # We can symlink the extensions to ~/.pi/agent/extensions/
    echo -e "Linking active extensions to $GLOBAL_PI_DIR/extensions/..."
    mkdir -p "$GLOBAL_PI_DIR/extensions"
    
    # Symlink each extension
    EXTENSIONS=("smart-router" "focus-mode")
    for ext in "${EXTENSIONS[@]}"; do
        if [ -L "$GLOBAL_PI_DIR/extensions/$ext" ]; then
            rm "$GLOBAL_PI_DIR/extensions/$ext"
        fi
        ln -sf "$PROJECT_DIR/extensions/$ext" "$GLOBAL_PI_DIR/extensions/$ext"
        echo -e "  ✔ Linked extension: $ext"
    done


    echo -e "\x1b[32m✔ Symlinks created successfully!\x1b[0m"
    echo -e "\n\x1b[33m👉 IMPORTANT: To complete registration, update your global ~/.pi/agent/settings.json:\x1b[0m"
    echo -e "💡 NOTE: Any active workflow/orchestration extensions may conflict with focus-mode."
    echo -e "   It is highly recommended to remove them from your settings (sample: \"git:github.com/HazAT/pi-solo\")."
    echo -e "\nUnder the \"packages\" array, register these two extensions:"
    echo -e "     \"local:extensions/smart-router\""
    echo -e "     \"local:extensions/focus-mode\""
else
    echo -e "\x1b[31m✗ Could not find global Pi Agent directory at $GLOBAL_PI_DIR.\x1b[0m"
    echo -e "Please clone your pi-config repo to ~/.pi/agent first, then re-run this script."
fi

echo -e "\n\x1b[32m✔ Setup complete!\x1b[0m"
