#!/usr/bin/env bash
# Runs ON the EC2 host (piped in over SSH by the GitHub Actions deploy job).
# Promotes the freshly-uploaded release (dist + production node_modules) in
# releases/next, applies database migrations, restarts the service and rolls back if the health check fails.
# Note: a rollback restores the previous code only; applied migrations stay.
set -euo pipefail

SERVICE=hbc
ROOT=/opt/$SERVICE
ENV_FILE="$ROOT/shared/$SERVICE.env"
KEEP=5

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE - run deploy/setup-ec2.sh first"; exit 1; }
[ -d "$ROOT/releases/next" ] || { echo "no uploaded release at $ROOT/releases/next"; exit 1; }

TS=$(date +%Y%m%d%H%M%S)
REL="$ROOT/releases/$TS"
PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)

mv "$ROOT/releases/next" "$REL"
cd "$REL"

# DATABASE_URL etc. for the migration step below.
set -a; . "$ENV_FILE"; set +a
export NODE_ENV=production
PORT=${PORT:-4000}

# node_modules arrives pre-installed from the CI runner (a full `npm ci` here
# gets OOM-killed on a small instance); every dependency is pure JavaScript.
echo "==> applying database migrations"
node dist/db/migrate.js

echo "==> switching 'current' symlink -> $TS"
ln -sfn "$REL" "$ROOT/current"

echo "==> restarting service"
sudo systemctl restart "$SERVICE"

echo "==> health check on port $PORT"
if ! curl -fsS --retry 10 --retry-delay 2 --retry-connrefused "http://127.0.0.1:$PORT/health"; then
  echo
  echo "!! health check failed - recent logs (database migrations are NOT reverted):"
  journalctl -u "$SERVICE" -n 60 --no-pager || true
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    echo "!! rolling back to $(basename "$PREVIOUS")"
    ln -sfn "$PREVIOUS" "$ROOT/current"
    sudo systemctl restart "$SERVICE"
  fi
  exit 1
fi
echo

echo "==> pruning old releases (keeping last $KEEP)"
ls -1dt "$ROOT"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf

echo "==> deployed $TS"
