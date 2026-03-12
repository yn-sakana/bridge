#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== bridge deploy ==="

# 1. venv
if [[ ! -d .venv ]]; then
    echo "[1/3] Creating Python venv..."
    python3 -m venv .venv
else
    echo "[1/3] venv exists"
fi

echo "[2/3] Installing dependencies..."
.venv/bin/pip install -q -r requirements.txt

# 3. systemd
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"
echo "[3/3] Installing systemd service..."
cat > "$SYSTEMD_DIR/bridge.service" << 'EOF'
[Unit]
Description=Bridge - Split-device AI chat relay
After=network.target fin-hub.service

[Service]
Type=simple
EnvironmentFile=%h/.env
Environment=FIN_HUB_URL=http://localhost:8400
Environment=BRIDGE_PORT=3001
WorkingDirectory=%h/bridge
ExecStart=%h/bridge/.venv/bin/uvicorn server.main:app --host 0.0.0.0 --port 3001
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable bridge.service
systemctl --user restart bridge.service
sleep 2
systemctl --user status bridge.service --no-pager || true

echo ""
echo "=== Deploy complete ==="
echo "  Logs: journalctl --user -u bridge -f"
