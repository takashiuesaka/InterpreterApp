#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREP_DOC="$ROOT_DIR/docs/electron-prerequisites.md"

if [[ ! -f "$PREP_DOC" ]]; then
  echo "[ERROR] prerequisites document not found: $PREP_DOC"
  exit 1
fi

echo "[INFO] Using prerequisites document: $PREP_DOC"

require_command() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERROR] '$cmd' is required. $hint"
    exit 1
  fi
}

require_command node "Install Node.js 22 LTS or later."
require_command npm "Install npm (usually bundled with Node.js)."
require_command git "Install Git before running this setup."

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" -lt 22 ]]; then
  echo "[ERROR] Node.js 22+ is required. Current: $(node -v)"
  exit 1
fi

echo "[INFO] Node: $(node -v)"
echo "[INFO] npm: $(npm -v)"
echo "[INFO] git: $(git --version)"

cd "$ROOT_DIR"

if [[ ! -f package.json ]]; then
  echo "[INFO] package.json not found. Creating minimal package.json"
  npm init -y >/dev/null
fi

echo "[INFO] Installing Electron Forge CLI and Electron"
npm install --save-dev @electron-forge/cli electron

echo "[INFO] Installing runtime dependencies"
npm install dotenv ws

echo "[INFO] Configuring package.json scripts"
npm pkg set scripts.start="electron-forge start"
npm pkg set scripts.package="electron-forge package"
npm pkg set scripts.make="electron-forge make"
npm pkg set scripts.publish="electron-forge publish"

if [[ ! -f "$ROOT_DIR/main.js" ]]; then
  echo "[INFO] main.js not found. Creating minimal Electron main process"
  cat > "$ROOT_DIR/main.js" <<'EOF'
const { app, BrowserWindow } = require('electron');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL('data:text/html;charset=utf-8,<html><body><h1>InterpreterApp</h1><p>Electron environment is ready.</p></body></html>');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
EOF
fi

npm pkg set main="main.js"

echo "[INFO] Verifying Electron Forge availability"
npx electron-forge --version

echo "[DONE] Electron development environment setup completed."
echo "[NEXT] Run: npm run start"
