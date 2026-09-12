#!/usr/bin/env bash
#
# NOROSA release activation — runs ON the EC2 instance after the GitHub
# Action uploads payload.tar.gz and this script to /tmp.
#
#   /tmp/norosa-payload/www/    → static frontend (nginx webroot)
#   /tmp/norosa-payload/relay/  → relay dist + package.json + package-lock.json
#
# Release layout (safe rollback: `current` is a symlink):
#   /var/www/norosa.app/releases/<ts>/  → current → newest
#   /opt/norosa-relay/releases/<ts>/    → current → newest
#   /opt/norosa-relay/data/             → persistent DB (outsite releases)
#
set -euo pipefail

# ── Preflight ───────────────────────────────────────────────────────
command -v node >/dev/null || { echo "ERROR: node not installed on EC2 — install Node 22 first."; exit 1; }
node -e "console.log('EC2 node:', process.version)"
command -v rsync >/dev/null || { echo "ERROR: rsync is required on EC2. Run: sudo apt-get install -y rsync"; exit 1; }
command -v nginx >/dev/null || { echo "ERROR: nginx not found on EC2."; exit 1; }
command -v sudo >/dev/null || { echo "ERROR: sudo missing — cannot manage services."; exit 1; }

TS=$(date -u +%Y%m%d%H%M%S)
ME=$(id -un)
WEB_REL="/var/www/norosa.app/releases/${TS}"
RLY_REL="/opt/norosa-relay/releases/${TS}"
CUR_WWW="/var/www/norosa.app/current"
CUR_RLY="/opt/norosa-relay/current"
DATA="/opt/norosa-relay/data"
PAYLOAD="/tmp/norosa-payload"
SVC="/etc/systemd/system/norosa-relay.service"

echo "=== release timestamp: ${TS} ==="

# ── Unpack ──────────────────────────────────────────────────────────
rm -rf "${PAYLOAD}"
mkdir -p "${PAYLOAD}"
tar -xzf /tmp/payload.tar.gz -C "${PAYLOAD}" --strip-components=1

# ── Create release dirs (owned by the deploy user) ──────────────────
sudo install -d -m 0755 -o "${ME}" -g "${ME}" \
  /var/www/norosa.app/releases \
  "${RLY_REL%/*}" \
  "${DATA}"
sudo install -d -m 0755 -o "${ME}" -g "${ME}" "${WEB_REL}" "${RLY_REL}"
cp -a "${PAYLOAD}/www/." "${WEB_REL}/"
cp -a "${PAYLOAD}/relay/." "${RLY_REL}/"
[ -f "${RLY_REL}/dist/index.js" ] || { echo "ERROR: relay release is missing dist/index.js"; exit 1; }
[ -f "${WEB_REL}/index.html" ] || { echo "ERROR: web release is missing index.html"; exit 1; }

# ── Relay runtime deps (production only, on the server) ─────────────
echo "=== relay: npm ci --omit=dev ==="
( cd "${RLY_REL}" && npm ci --omit=dev --no-audit --no-fund --prefer-offline )

# ── Swap symlinks ──────────────────────────────────────────────────
echo "=== swapping symlinks ==="
sudo ln -sfn "${WEB_REL}" "${CUR_WWW}"
sudo ln -sfn "${RLY_REL}" "${CUR_RLY}"

# ── systemd unit (created once; never overwritten) ─────────────────
if [ ! -f "${SVC}" ]; then
  echo "=== creating ${SVC} ==="
  sudo tee "${SVC}" >/dev/null <<'UNIT'
[Unit]
Description=NOROSA blind relay (WebSocket gate)
After=network.target

[Service]
Type=simple
User=__USER__
Group=__USER__
WorkingDirectory=/opt/norosa-relay/current
Environment=NODE_ENV=production
Environment=PORT=8081
Environment=DB_PATH=/opt/norosa-relay/data/relay.sqlite
ExecStart=/usr/bin/node /opt/norosa-relay/current/dist/index.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
  sudo sed -i "s/__USER__/${ME}/" "${SVC}"
  sudo systemctl daemon-reload
  sudo systemctl enable norosa-relay
else
  echo "=== ${SVC} already exists — unchanged ==="
fi

# ── Restart relay ──────────────────────────────────────────────────
echo "=== restarting norosa-relay ==="
sudo systemctl restart norosa-relay
sleep 2
systemctl is-active norosa-relay
systemctl is-enabled norosa-relay

# ── Websocket handshake probe ─────────────────────────────────────
echo "=== probing ws://127.0.0.1:8081 (expect open) ==="
( cd "${RLY_REL}" && node -e "
const WebSocket=require('ws');
const ws=new WebSocket('ws://127.0.0.1:8081/');
const t=setTimeout(()=>{console.error('probe timeout — connection never opened');process.exit(1)},4000);
ws.on('open',()=>{clearTimeout(t);console.log('relay ws handshake: OPEN');process.exit(0)});
ws.on('error',(e)=>{clearTimeout(t);console.error('relay ws error:',e.message);process.exit(1)});
" )

# ── nginx ──────────────────────────────────────────────────────────
echo "=== nginx test + reload ==="
sudo nginx -t
sudo systemctl reload nginx

# ── Verify site serves the NEW build ───────────────────────────────
echo "=== exposed release ==="
readlink -f "${CUR_WWW}" || true
readlink -f "${CUR_RLY}" || true
echo "=== wss in served assets ==="
grep -rl "wss://norosa.app/ws" "${CUR_WWW}" || echo "(no explicit ws string found in static assets — acceptable if pre-rendered)"

# ── Prune releases older than 7 days ───────────────────────────────
echo "=== pruning releases older than 7 days ==="
find /var/www/norosa.app/releases -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec sudo rm -rf {} + 2>/dev/null || true
find /opt/norosa-relay/releases -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec sudo rm -rf {} + 2>/dev/null || true

echo "=== DONE ==="