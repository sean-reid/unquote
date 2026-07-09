#!/bin/bash
# First-boot server setup. Run as root on a fresh Ubuntu LTS box:
#   curl -fsSL https://raw.githubusercontent.com/sean-reid/unquote/main/infra/ops/setup.sh | bash
# Idempotent: safe to re-run.
set -euo pipefail

REPO_URL="https://github.com/sean-reid/unquote.git"
APP_DIR=/opt/unquote

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git zstd ufw unattended-upgrades

# Docker via the official convenience script, only if missing.
if ! command -v docker > /dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# Container logs must not fill the disk.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
EOF
systemctl restart docker

# Security updates apply themselves.
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# Firewall: ssh (rate limited; brute-force noise otherwise fills the log)
# and the web, nothing else.
ufw limit OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# The app lives in a clone of the public repo.
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi

# Disk watchdog, hourly.
install -m 0755 "$APP_DIR/infra/ops/diskwatch.sh" /usr/local/bin/unquote-diskwatch
cat > /etc/cron.d/unquote-diskwatch << 'EOF'
0 * * * * root /usr/local/bin/unquote-diskwatch
EOF

echo "setup complete. Next: create $APP_DIR/infra/.env from .env.example, then run deploy.sh from your machine."
