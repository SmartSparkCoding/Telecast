#!/usr/bin/env bash
# Put Telecast on this machine, on port 12345, with the control panel PIN 000000.
# Run it again any time to update: it pulls, rebuilds and restarts.
set -euo pipefail

REPO="${REPO:-https://github.com/SmartSparkCoding/Telecast.git}"
BRANCH="${BRANCH:-main}"
DIR="${DIR:-$HOME/telecast}"
PORT="${PORT:-12345}"
PIN="${PIN:-000000}"
DATA_DIR="${DATA_DIR:-$DIR/data}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. Install it first." >&2; exit 1; }; }
need git
need node
if [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  echo "Telecast needs Node 22 or newer. This machine has $(node -v)." >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "==> Updating $DIR"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH" 2>/dev/null || git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
  git -C "$DIR" reset --hard -q "origin/$BRANCH"
else
  echo "==> Cloning into $DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR"
echo "==> Installing and building"
npm install --no-fund --no-audit
npm run build

cat > "$DIR/.env" <<ENV
PORT=$PORT
DATA_DIR=$DATA_DIR
TELECAST_PIN=$PIN
ENV
mkdir -p "$DATA_DIR"

if [ -f "$DIR/telecast.pid" ] && kill -0 "$(cat "$DIR/telecast.pid")" 2>/dev/null; then
  echo "==> Stopping the old copy"
  kill "$(cat "$DIR/telecast.pid")" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$(cat "$DIR/telecast.pid")" 2>/dev/null || break
    sleep 0.25
  done
fi

echo "==> Starting on port $PORT"
set -a; . "$DIR/.env"; set +a
nohup node dist/server.cjs >> "$DIR/telecast.log" 2>&1 &
echo $! > "$DIR/telecast.pid"

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo
    echo "Telecast is running."
    echo "  Screens:  http://<this-machine>:$PORT/"
    echo "  Control:  http://<this-machine>:$PORT/control"
    echo "  PIN:      $PIN"
    echo "  Log:      $DIR/telecast.log"
    exit 0
  fi
  sleep 0.5
done

echo "It didn't answer on port $PORT. Last lines of the log:" >&2
tail -n 30 "$DIR/telecast.log" >&2
exit 1
