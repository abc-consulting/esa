#!/usr/bin/env bash
# Oracle Cloud Ubuntu 22.04 setup script for ESA App
# Run once as root: sudo bash deploy/setup.sh
set -euo pipefail

REPO="https://github.com/abc-consulting/esa.git"
APP_DIR="/opt/esa"
APP_USER="esa"
ENV_FILE="/etc/esa/env"
SERVICE_NAME="esa"

log() { echo "==> $*"; }

# ── 1. System update ──────────────────────────────────────────────────────────
log "Updating system packages..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq

# ── 2. Node.js LTS ───────────────────────────────────────────────────────────
log "Installing Node.js LTS..."
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - >/dev/null
apt-get install -y -qq nodejs

# ── 3. nginx ─────────────────────────────────────────────────────────────────
log "Installing nginx..."
apt-get install -y -qq nginx

# ── 4. App user ───────────────────────────────────────────────────────────────
if ! id "$APP_USER" &>/dev/null; then
  log "Creating user '$APP_USER'..."
  useradd -r -m -s /bin/bash "$APP_USER"
fi

# ── 5. Clone / update repo ────────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  log "Repo already exists — pulling latest..."
  git -C "$APP_DIR" pull --ff-only
else
  log "Cloning repo to $APP_DIR..."
  git clone "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 6. data/ directory ────────────────────────────────────────────────────────
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"

# ── 7. Credentials file ───────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "Creating credentials placeholder at $ENV_FILE..."
  mkdir -p "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<'EOF'
# RedVelvet credentials (optional — remove or leave blank for anonymous mode)
# RV_EMAIL=your@email.com
# RV_PASSWORD=yourpassword
EOF
  chmod 600 "$ENV_FILE"
fi

# ── 8. systemd service ────────────────────────────────────────────────────────
log "Installing systemd service..."
cp "$APP_DIR/deploy/esa.service" /etc/systemd/system/esa.service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ── 9. nginx config ───────────────────────────────────────────────────────────
log "Configuring nginx..."
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/esa
ln -sf /etc/nginx/sites-available/esa /etc/nginx/sites-enabled/esa
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

# ── 10. Firewall ─────────────────────────────────────────────────────────────
log "Configuring ufw..."
ufw allow 22/tcp  comment 'SSH'
ufw allow 80/tcp  comment 'HTTP'
ufw --force enable

# ── Done ──────────────────────────────────────────────────────────────────────
PUBLIC_IP=$(curl -s --max-time 5 http://checkip.amazonaws.com/ 2>/dev/null || echo "<your-public-ip>")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ESA App is running at: http://${PUBLIC_IP}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  To add RedVelvet credentials:"
echo "    sudo nano ${ENV_FILE}"
echo "    sudo systemctl restart ${SERVICE_NAME}"
echo ""
echo "  Useful commands:"
echo "    systemctl status ${SERVICE_NAME}"
echo "    journalctl -u ${SERVICE_NAME} -f"
echo "    systemctl restart ${SERVICE_NAME}"
echo "    nginx -t && systemctl reload nginx"
echo ""
