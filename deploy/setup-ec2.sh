#!/usr/bin/env bash
# One-time provisioning for a fresh Amazon Linux 2023 EC2 host.
# Copy the deploy/ folder to the host and run as ec2-user (sudo-capable):
#   bash deploy/setup-ec2.sh
set -euo pipefail

NODE_MAJOR=22
SERVICE=hbc
ROOT=/opt/$SERVICE
SVC_USER=hbc
DEPLOY_USER=${SUDO_USER:-$USER}
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> checking OS"
. /etc/os-release
if [ "${ID:-}" != "amzn" ] || [ "${VERSION_ID:-}" != "2023" ]; then
  echo "This script targets Amazon Linux 2023 (found: ${PRETTY_NAME:-unknown})."
  echo "Amazon Linux 2 is not supported: Node ${NODE_MAJOR} needs glibc 2.28+, AL2 has 2.26."
  exit 1
fi

echo "==> base packages"
# curl is already there as curl-minimal - installing 'curl' would conflict.
sudo dnf install -y rsync tar

echo "==> Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
  sudo dnf install -y nodejs
fi
node -v
npm -v

echo "==> service user + directories"
sudo useradd --system --no-create-home --home-dir "$ROOT" --shell "$(command -v nologin || echo /sbin/nologin)" "$SVC_USER" 2>/dev/null || true
sudo mkdir -p "$ROOT/releases" "$ROOT/shared"
# The deploy user (GitHub Actions) uploads releases and flips the 'current'
# symlink; the service user only needs to read the tree.
sudo chown -R "$DEPLOY_USER:$SVC_USER" "$ROOT"
sudo chmod -R g+rX "$ROOT"

echo "==> env file"
if [ ! -f "$ROOT/shared/$SERVICE.env" ]; then
  sudo cp "$HERE/$SERVICE.env.example" "$ROOT/shared/$SERVICE.env"
  # Readable by the deploy user (remote-release.sh sources it) and the service.
  sudo chown "$DEPLOY_USER:$SVC_USER" "$ROOT/shared/$SERVICE.env"
  sudo chmod 640 "$ROOT/shared/$SERVICE.env"
  echo "   -> edit $ROOT/shared/$SERVICE.env before the first deploy"
fi

echo "==> systemd unit"
sudo cp "$HERE/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
# ExecStart uses /usr/bin/node - make sure that's where Node landed.
[ -x /usr/bin/node ] || sudo ln -sf "$(command -v node)" /usr/bin/node
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"

echo "==> sudoers: let the deploy user restart the service without a password"
cat <<EOF | sudo tee "/etc/sudoers.d/$SERVICE-deploy" >/dev/null
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE, /usr/bin/systemctl status $SERVICE
EOF
sudo chmod 440 "/etc/sudoers.d/$SERVICE-deploy"
sudo visudo -cf "/etc/sudoers.d/$SERVICE-deploy"

cat <<EOF

Done. Next:
  1. Edit  $ROOT/shared/$SERVICE.env   (DATABASE_URL, PAYMENT_WEBHOOK_SECRET, PORT)
  2. If HBC was started by hand / pm2 before, stop it so port 4000 is free:  pm2 delete all && pm2 save
  3. Add these GitHub secrets (Settings > Environments > production):
       EC2_HOST     = this host's public DNS / IP
       EC2_USER     = $DEPLOY_USER
       EC2_SSH_KEY  = the private key (.pem) you use to SSH in as $DEPLOY_USER
  4. Push to main - the CI/CD workflow tests, builds and deploys here.
EOF
