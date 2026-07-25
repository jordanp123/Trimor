#!/usr/bin/env bash
# Install the WebSWR Quadlet + auto-update units for the CURRENT (rootless) user.
# Copies units into the user's systemd/Quadlet directories and reloads. Safe to
# re-run after editing any unit, pulling new versions, or MOVING the webroot.
#
#   ./deploy/install.sh                          # detects the webroot, asks to confirm
#   ./deploy/install.sh --yes                    # accept the detected webroot, no prompt
#   ./deploy/install.sh --base-dir ~/webswr      # explicit path, no prompt
#   WEBSWR_BASE=~/webswr ./deploy/install.sh     # same, via the environment
#
# Why this matters: Quadlet units are systemd units, so they do NOT expand
# ${VAR} the way docker-compose does. This script does that interpolation once
# -- it rewrites the shipped placeholder %h/webswr to the webroot you actually
# use, and writes APP_UID / TUNNEL_UID / STACK_NAME / SUBPATH from your
# config.webswr into the units. config.webswr stays the single source of truth;
# nothing needs hand-editing.
#
# NOTE the build context is the WEBROOT (the assembled site: index.html, css/,
# js/, Dockerfile, config.webswr), not the git checkout -- the checkout lives
# inside it. On a fresh install the webroot is not assembled yet; the updater
# does that on its first run.
#
# Every unit is prefixed `webswr-`, because Quadlet units are flat and per-user:
# a generic name would collide with another project's units in the same
# directory if this host runs more than one site that way.
#
# Then follow the "Next steps" it prints (create the tunnel secret, enable
# linger, run the updater, enable the timer).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# The placeholder baked into the shipped units (also the standard location, so a
# hand-copied unit works unmodified for a ~/webswr webroot).
UNIT_PLACEHOLDER='%h/webswr'

QUADLET_DIR="${HOME}/.config/containers/systemd"
UNIT_DIR="${HOME}/.config/systemd/user"
BIN_DIR="${HOME}/.local/bin"

# Print the header comment above (everything from line 2 to the first
# non-comment line), so usage text can never drift from the real flags.
usage() {
  awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "${BASH_SOURCE[0]}"
}

# ── Arguments ────────────────────────────────────────────────────────────────
BASE_DIR="${WEBSWR_BASE:-}"
ASSUME_YES=0
[ -n "$BASE_DIR" ] && ASSUME_YES=1

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--base-dir)
      [ $# -ge 2 ] || { echo "!! $1 needs a path" >&2; exit 2; }
      BASE_DIR="$2"; ASSUME_YES=1; shift 2 ;;
    --base-dir=*)
      BASE_DIR="${1#*=}"; ASSUME_YES=1; shift ;;
    -y|--yes)   ASSUME_YES=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "!! unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

expand_tilde() {
  case "$1" in
    '~')   printf '%s' "$HOME" ;;
    '~/'*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

# A usable webroot holds config.webswr. Everything else (the assembled site,
# the Dockerfile) is produced by the updater, so it may legitimately be absent
# on a fresh install -- that is a note below, not an error here.
check_base() {
  local dir="$1"
  [ -n "$dir" ] || { echo "!! empty path" >&2; return 1; }
  [ -d "$dir" ] || { echo "!! not a directory: $dir" >&2; return 1; }
  [ -f "$dir/config.webswr" ] || {
    echo "!! no config.webswr in $dir" >&2
    echo "   cp $CHECKOUT_ROOT/config.webswr.example $dir/config.webswr  # then edit" >&2
    return 1; }
  return 0
}

# The webroot is the checkout's parent in the standard layout (<base>/<checkout>).
DETECTED="$(cd "$CHECKOUT_ROOT/.." && pwd)"
BASE_DIR="$(expand_tilde "${BASE_DIR:-}")"

if [ -z "$BASE_DIR" ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  while :; do
    printf '\n' >&2
    printf 'Webroot that holds config.webswr and the assembled site (build context).\n' >&2
    printf '  Detected: %s\n' "$DETECTED" >&2
    printf '  Standard: %s\n' "$HOME/webswr" >&2
    read -r -p '  Path [Enter = detected]: ' answer || answer=''
    answer="$(expand_tilde "${answer:-$DETECTED}")"
    if check_base "$answer"; then BASE_DIR="$answer"; break; fi
  done
fi

BASE_DIR="${BASE_DIR:-$DETECTED}"
check_base "$BASE_DIR" || {
  echo "!! refusing to install units pointing at an unusable webroot" >&2
  echo "   pass a good one:  $0 --base-dir /path/to/webswr" >&2
  exit 1; }
BASE_DIR="$(cd "$BASE_DIR" && pwd)"   # absolute, symlinks resolved

# ── Values from config.webswr (parsed as DATA, never sourced) ────────────────
cfg() { sed -n "s/^$1=//p" "$BASE_DIR/config.webswr" | tail -1 | tr -d '\r'; }
CHECKOUT_DIR="$(cfg CHECKOUT_DIR)"; APP_UID="$(cfg APP_UID)"
TUNNEL_UID="$(cfg TUNNEL_UID)";     STACK_NAME="$(cfg STACK_NAME)"
SUBPATH="$(cfg SUBPATH)"
: "${CHECKOUT_DIR:=Trimor}"; : "${APP_UID:=17001}"; : "${TUNNEL_UID:=17000}"
: "${STACK_NAME:=WebSWR}";   : "${SUBPATH:=webswr}"

for v in APP_UID TUNNEL_UID; do
  case "${!v}" in
    *[!0-9]*|"") echo "!! config.webswr $v must be numeric (got '${!v}')" >&2; exit 1 ;;
  esac
done
case "$STACK_NAME" in *[!A-Za-z0-9_-]*|"")
  echo "!! config.webswr STACK_NAME must be A-Za-z0-9_- (got '$STACK_NAME')" >&2; exit 1 ;;
esac
case "$SUBPATH" in .) ;; *[!A-Za-z0-9._-]*|""|*..*)
  echo "!! config.webswr SUBPATH must be a plain path segment or '.' (got '$SUBPATH')" >&2; exit 1 ;;
esac

# ── Host sanity checks (warnings only -- none of these block installing) ─────
[ -d "$BASE_DIR/$CHECKOUT_DIR/.git" ] || echo "** warning: no git checkout at $BASE_DIR/$CHECKOUT_DIR — the updater will clone it on its first run"
[ -f "$BASE_DIR/Dockerfile" ] || echo "** note: webroot not assembled yet — run the updater (step 3 below) before starting the services"
case "$BASE_DIR" in *[[:space:]]*)
  echo "** warning: the path contains whitespace; systemd/Quadlet handling of that is fragile — a webroot at ~/webswr avoids it" ;;
esac

if command -v podman >/dev/null 2>&1; then
  PODMAN_VER="$(podman --version 2>/dev/null | awk '{print $3}')"
  case "${PODMAN_VER%%.*}" in
    ''|*[!0-9]*) echo "** warning: could not parse 'podman --version' output" ;;
    *) [ "${PODMAN_VER%%.*}" -ge 5 ] || echo "** warning: podman $PODMAN_VER — these units expect Podman 5+" ;;
  esac
else
  echo "** warning: podman is not installed on this host — installing the units anyway"
fi

# Running both stacks at once gives Cloudflare two origins for the same tunnel.
# (Harmless while migrating -- both serve identical bytes -- but not a resting state.)
if command -v docker >/dev/null 2>&1 &&
   docker ps --format '{{.Names}}' 2>/dev/null | grep -qE "^(${STACK_NAME}|cloudflared-tunnel-${STACK_NAME})$"; then
  echo "** note: the docker compose stack is still RUNNING. That is fine while you"
  echo "         verify, but stop it once you are happy: docker compose down"
fi

podman secret inspect webswr-tunnel-token >/dev/null 2>&1 ||
  echo "** note: the podman secret 'webswr-tunnel-token' does not exist yet — see step 1 below"

# ── Install (rewriting placeholders as we go) ────────────────────────────────
# Prefer the %h specifier when the webroot is under $HOME so the installed units
# stay readable and portable; the update SCRIPT gets the literal path, since a
# shell script cannot expand %h.
case "$BASE_DIR" in
  "$HOME")   UNIT_PATH='%h' ;;
  "$HOME"/*) UNIT_PATH="%h/${BASE_DIR#"$HOME"/}" ;;
  *)         UNIT_PATH="$BASE_DIR" ;;
esac

sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
common_exprs() {   # <path-replacement>
  printf -- '-e s|%s|%s|g '            "$(sed_escape "$UNIT_PLACEHOLDER")" "$(sed_escape "$1")"
  printf -- '-e s|^User=17001$|User=%s| '   "$APP_UID"
  printf -- '-e s|^Group=17001$|Group=%s| ' "$APP_UID"
  printf -- '-e s|^User=17000$|User=%s| '   "$TUNNEL_UID"
  printf -- '-e s|^Group=17000$|Group=%s| ' "$TUNNEL_UID"
  printf -- '-e s|^ContainerName=WebSWR$|ContainerName=%s| ' "$(sed_escape "$STACK_NAME")"
  printf -- '-e s|^ContainerName=cloudflared-tunnel-WebSWR$|ContainerName=cloudflared-tunnel-%s| ' "$(sed_escape "$STACK_NAME")"
  printf -- '-e s|^BuildArg=SUBPATH=webswr$|BuildArg=SUBPATH=%s| ' "$(sed_escape "$SUBPATH")"
}
render() {  # render <mode> <src> <dest-dir> <path-replacement>
  local mode="$1" src="$2" dest="$3/$(basename "$2")" repl="$4" tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2046  # deliberate: build the -e list from common_exprs
  sed $(common_exprs "$repl") "$src" > "$tmp"
  install -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
}

mkdir -p "$QUADLET_DIR" "$UNIT_DIR" "$BIN_DIR"

echo "==> Webroot / build context -> $BASE_DIR  (units use: $UNIT_PATH)"
echo "==> From config.webswr      -> APP_UID=$APP_UID TUNNEL_UID=$TUNNEL_UID STACK_NAME=$STACK_NAME SUBPATH=$SUBPATH"

echo "==> Quadlet units           -> $QUADLET_DIR"
for f in "$SCRIPT_DIR"/quadlet/*.network "$SCRIPT_DIR"/quadlet/*.build "$SCRIPT_DIR"/quadlet/*.container; do
  render 0644 "$f" "$QUADLET_DIR" "$UNIT_PATH"
done

echo "==> Timer + service         -> $UNIT_DIR"
render 0644 "$SCRIPT_DIR/systemd/webswr-update.service" "$UNIT_DIR" "$UNIT_PATH"
render 0644 "$SCRIPT_DIR/systemd/webswr-update.timer"   "$UNIT_DIR" "$UNIT_PATH"

echo "==> Update script           -> $BIN_DIR"
render 0755 "$SCRIPT_DIR/bin/webswr-update.sh" "$BIN_DIR" "$BASE_DIR"   # literal path, not %h

echo "==> systemctl --user daemon-reload"
systemctl --user daemon-reload
# A previous failed build/start leaves units in 'failed'; clear it so the next
# start isn't refused or misread as the new attempt failing.
systemctl --user reset-failed webswr-website-build.service webswr-website.service \
  webswr-cloudflared.service webswr-update.service >/dev/null 2>&1 || true

# Cheap sanity check: let Podman's own generator parse what we just wrote.
if [ -x /usr/libexec/podman/quadlet ]; then
  if quadlet_out="$(/usr/libexec/podman/quadlet -user -dryrun 2>&1)"; then
    echo "==> quadlet -dryrun: units parse OK"
  else
    echo "** quadlet -dryrun reported a problem:" >&2
    printf '%s\n' "$quadlet_out" >&2
  fi
fi

cat <<EOF

Installed. Units build from: $BASE_DIR
(Move or re-clone later? Just re-run this script from the new copy.)

Next steps (rootless, run as this user):

  1. Create the tunnel-token secret once. From an existing Docker deployment:
       sed -n 's/^TUNNEL_TOKEN=//p' "$BASE_DIR/.env" | tr -d '\\r\\n' \\
         | podman secret create webswr-tunnel-token -
     …or straight from the Cloudflare dashboard token:
       printf '%s' 'YOUR-TUNNEL-TOKEN' | podman secret create webswr-tunnel-token -
     (printf, NOT echo — a trailing newline corrupts the token.)

  2. Let the services run without an active login session:
       loginctl enable-linger "\$USER"

  3. Assemble the webroot, fetch data, build and start everything:
       systemctl --user start webswr-update.service
       journalctl --user -u webswr-update -f

  4. Turn on the daily refresh (05:00 + up to 15m jitter):
       systemctl --user enable --now webswr-update.timer

  Check:  systemctl --user status webswr-website webswr-cloudflared
  Logs:   journalctl --user -u webswr-website -u webswr-cloudflared -f
  Deploy log: $BASE_DIR/update.log
EOF
