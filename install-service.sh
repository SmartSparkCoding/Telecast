#!/usr/bin/env bash
# Put Telecast on this machine as a systemd service, so it comes back after a reboot
# or a crash. Run it again any time to update: it pulls, rebuilds and restarts.
#
#   curl -fsSL https://raw.githubusercontent.com/SmartSparkCoding/Telecast/main/install-service.sh | sudo bash
#
# Override anything by putting it in front of bash:
#   curl -fsSL .../install-service.sh | sudo PORT=8080 TELECAST_PIN=4821 bash
set -euo pipefail

REPO="${REPO:-https://github.com/SmartSparkCoding/Telecast.git}"
BRANCH="${BRANCH:-main}"
DIR="${DIR:-/opt/telecast}"
PORT_GIVEN="${PORT:-}"
PIN_GIVEN="${PIN:-}"
PORT="${PORT:-12345}"
PIN="${PIN:-000000}"
NODE_DIR="${NODE_DIR:-/opt/node22}"
SERVICE="${SERVICE:-telecast}"
RUN_USER="${RUN_USER:-root}"
ENV_FILE="${ENV_FILE:-/etc/telecast.env}"
DRY_RUN="${DRY_RUN:-}"

say() { printf '==> %s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

if [ -z "$DRY_RUN" ] && [ "$(id -u)" -ne 0 ]; then
  die "Run this as root, e.g. curl -fsSL .../install-service.sh | sudo bash"
fi

# ---- is there a systemd to install into? -----------------------------------
if [ -z "$DRY_RUN" ]; then
  command -v systemctl >/dev/null 2>&1 || die "No systemctl here, so there's no service to install. Use deploy.sh instead."
  [ -d /run/systemd/system ] || die "systemd isn't running on this machine (a container?). Use deploy.sh instead."
fi

# ---- the basics -------------------------------------------------------------
missing=""
for tool in git curl tar xz; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  say "Installing$missing"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq $missing >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q $missing
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache $missing
  else
    die "Install these first:$missing"
  fi
fi

# ---- Node 22.18 or newer ----------------------------------------------------
# The build runs build.ts straight through node, which needs node's own TypeScript
# support: 22.18 and up. Anything older has to be fetched.
node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' >/dev/null 2>&1
}

if [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
  NODE="$NODE_DIR/bin/node"
  say "Using $("$NODE" -v) from $NODE_DIR"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
  say "Using $("$NODE" -v), already on this machine"
else
  if command -v node >/dev/null 2>&1; then current="$(node -v)"; else current="no node"; fi
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "No prebuilt Node for $(uname -m). Install Node 22.18 or newer, then run this again." ;;
  esac
  say "This machine has $current. Getting Node 22 into $NODE_DIR"
  listing="$(curl -fsSL --max-time 30 https://nodejs.org/dist/latest-v22.x/ || true)"
  [ -n "$listing" ] || die "Couldn't reach nodejs.org to download Node 22."
  tarball="$(printf '%s\n' "$listing" | grep -o "node-v[0-9.]*-linux-${arch}\.tar\.xz" | head -n 1)"
  [ -n "$tarball" ] || die "Couldn't work out which Node 22 download to use."
  mkdir -p "$NODE_DIR"
  tmp="$(mktemp -d)"
  curl -fsSL --max-time 300 "https://nodejs.org/dist/latest-v22.x/$tarball" -o "$tmp/node.tar.xz" ||
    die "Downloading $tarball failed."
  tar -xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  NODE="$NODE_DIR/bin/node"
  say "Using $("$NODE" -v) from $NODE_DIR"
fi
export PATH="$(dirname "$NODE"):$PATH"

# ---- keep the settings a previous run left behind ---------------------------
PUBLIC_URL="${PUBLIC_URL:-}"
# Re-running this is meant to update the code, not to reset a PIN the organiser changed,
# so what's already in the settings file wins unless this run was given one explicitly.
if [ -f "$ENV_FILE" ]; then
  old_pin="$(grep -o '^TELECAST_PIN=.*' "$ENV_FILE" | cut -d= -f2- || true)"
  old_port="$(grep -o '^PORT=.*' "$ENV_FILE" | cut -d= -f2- || true)"
  old_url="$(grep -o '^PUBLIC_URL=.*' "$ENV_FILE" | cut -d= -f2- || true)"
  if [ -z "$PIN_GIVEN" ] && [ -n "$old_pin" ]; then PIN="$old_pin"; fi
  if [ -z "$PORT_GIVEN" ] && [ -n "$old_port" ]; then PORT="$old_port"; fi
  if [ -z "$PUBLIC_URL" ] && [ -n "$old_url" ]; then PUBLIC_URL="$old_url"; fi
fi
DATA_DIR="${DATA_DIR:-$DIR/data}"

# ---- the code ---------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH" 2>/dev/null ||
    git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
  git -C "$DIR" reset --hard -q "origin/$BRANCH"
else
  say "Cloning into $DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR"
say "Installing and building"
npm install --no-fund --no-audit >/dev/null
npm run build

# ---- clear the port ---------------------------------------------------------
if [ -z "$DRY_RUN" ] && systemctl list-unit-files "$SERVICE.service" >/dev/null 2>&1; then
  systemctl stop "$SERVICE" 2>/dev/null || true
fi
if [ -f "$DIR/telecast.pid" ] && kill -0 "$(cat "$DIR/telecast.pid")" 2>/dev/null; then
  say "Stopping the copy deploy.sh started"
  kill "$(cat "$DIR/telecast.pid")" 2>/dev/null || true
  rm -f "$DIR/telecast.pid"
  sleep 1
fi
port_busy() {
  command -v ss >/dev/null 2>&1 || return 1
  ss -ltnH 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$"' | grep -q .
}

# An older run can outlive its pidfile: the first deploy.sh here left one in a folder
# that was then deleted, and it sat on the port. If the thing holding the port is this
# same server, replace it; only refuse when it's somebody else's process.
if port_busy; then
  busy_pid="$(ss -ltnpH 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$"' | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2)"
  if [ -n "${busy_pid:-}" ] && tr '\0' ' ' < "/proc/$busy_pid/cmdline" 2>/dev/null | grep -q "server.cjs"; then
    say "Stopping the older Telecast holding port $PORT (pid $busy_pid)"
    kill "$busy_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do port_busy || break; sleep 0.25; done
  fi
fi
if port_busy; then
  echo "Something else is listening on port $PORT:" >&2
  ss -ltnpH 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$"' >&2 || true
  die "Stop that, or run again with PORT=<other>."
fi

# ---- settings file ----------------------------------------------------------
mkdir -p "$DATA_DIR"
{
  echo "PORT=$PORT"
  echo "DATA_DIR=$DATA_DIR"
  echo "TELECAST_PIN=$PIN"
  [ -n "$PUBLIC_URL" ] && echo "PUBLIC_URL=$PUBLIC_URL"
  true
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "Wrote $ENV_FILE (PIN $PIN)"

# ---- the unit ---------------------------------------------------------------
cat > /tmp/telecast.service.$$ <<UNIT
[Unit]
Description=Telecast screens and control panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE $DIR/dist/server.cjs
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT

if [ -n "$DRY_RUN" ]; then
  say "Dry run, so nothing was installed. The unit would be:"
  cat /tmp/telecast.service.$$
  rm -f /tmp/telecast.service.$$
  exit 0
fi

install -m 0644 /tmp/telecast.service.$$ "/etc/systemd/system/$SERVICE.service"
rm -f /tmp/telecast.service.$$

say "Starting $SERVICE"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    cat <<DONE

Telecast is running as a service and starts again on boot.

  Screens:  http://${ip:-<this-machine>}:$PORT/
  Control:  http://${ip:-<this-machine>}:$PORT/control
  PIN:      $PIN
  Logs:     journalctl -u $SERVICE -f
  Restart:  systemctl restart $SERVICE
  Update:   run this same command again
DONE
    exit 0
  fi
  sleep 0.5
done

echo "It didn't answer on port $PORT. Last lines:" >&2
journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
exit 1
