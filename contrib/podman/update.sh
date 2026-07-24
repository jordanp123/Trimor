#!/bin/bash
# WebSWR daily deploy -- ROOTLESS PODMAN variant of the repo-root update.sh.
# Run it as the unprivileged deploy user (never as root), from a systemd user
# timer or that user's crontab. Requires Podman 5+ and the quadlet units from
# this directory installed in ~/.config/containers/systemd/.
#
# Same failsafe ordering as the Docker script: pull before touching the webroot,
# build the new image before pruning anything -- any failure aborts (set -e) and
# the running containers keep serving last-known-good. The braces make bash
# parse the whole file before executing any of it, so the cp below replacing
# this script mid-run can't corrupt this run.
#
# Differences from the Docker variant, all consequences of being rootless:
#   * no setpriv privilege drop and no chowns -- the whole script already runs
#     unprivileged, and an unprivileged user cannot switch UIDs anyway. The
#     fetchers keep their throwaway staging dir and symlink-guarded copy-back.
#   * FETCH_UID / APP_UID / TUNNEL_UID / STACK_NAME are not read here: quadlet
#     files are systemd units and do not expand ${VAR}, so those values live
#     literally in the .container units next to this file.
#   * `docker compose up -d` becomes `podman build` + `systemctl --user restart`.
{
set -eEu

# Unit names, matching the quadlet filenames shipped in this directory.
# Rename here too if you rename those files.
SITE_UNIT="webswr.service"
TUNNEL_UNIT="webswr-tunnel.service"
IMAGE_TAG="localhost/webswr:latest"
TUNNEL_IMAGE="docker.io/cloudflare/cloudflared:latest"

if [ "$(id -u)" = "0" ]; then
  echo "FATAL: this is the ROOTLESS variant -- run it as the unprivileged deploy" >&2
  echo "user (e.g. 'webswr'), not as root. Root-owned files in the webroot would" >&2
  echo "break the user services. For rootful podman, drop the --user flags below." >&2
  exit 1
fi
command -v podman >/dev/null || { echo "FATAL: podman is not installed" >&2; exit 1; }
# A user crontab does not set XDG_RUNTIME_DIR, and `systemctl --user` fails
# without it. Harmless when already set (systemd user timers set it for us).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
systemctl --user show-environment >/dev/null 2>&1 || {
  echo "FATAL: cannot reach the systemd user manager. Is lingering enabled?" >&2
  echo "  loginctl enable-linger $(id -un)   # as root, once" >&2
  exit 1
}

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# Parent-of-parent first: this script ships inside the checkout at
# <webroot>/<checkout>/contrib/podman/, so the webroot is three levels up when
# cron runs the checkout's copy; a copy placed directly in the webroot works too.
if [ -f "$SELF_DIR/../../../config.webswr" ]; then BASE="$(cd "$SELF_DIR/../../.." && pwd)";
elif [ -f "$SELF_DIR/config.webswr" ]; then BASE="$SELF_DIR";
else
  echo "FATAL: config.webswr not found above $SELF_DIR." >&2
  echo "Copy config.webswr.example to the webroot as config.webswr and edit it" >&2
  echo "(it sits NEXT TO .env, above the git checkout). Nothing was changed." >&2
  exit 1
fi

# config.webswr is parsed as DATA, never sourced -- a config file should not be
# able to execute code, and a malformed line gets a clear FATAL instead of bash
# noise. KEY=value lines only; last assignment wins; CRLF tolerated.
cfg() { sed -n "s/^$1=//p" "$BASE/config.webswr" | tail -1 | tr -d '\r'; }
REPO_URL="$(cfg REPO_URL)"
CHECKOUT_DIR="$(cfg CHECKOUT_DIR)"
SUBPATH="$(cfg SUBPATH)"

# Validate BEFORE touching anything: a typo'd or missing value aborts here with
# the webroot untouched and the running site still serving.
[ -n "$REPO_URL" ] || { echo "FATAL: config.webswr must set REPO_URL" >&2; exit 1; }
case "$CHECKOUT_DIR" in
  *[!A-Za-z0-9._-]*|""|.|..|*..*) echo "FATAL: CHECKOUT_DIR must be a plain directory name (A-Za-z0-9._- and no '..')" >&2; exit 1 ;;
esac
case "$SUBPATH" in
  .) ;; # sanctioned: serve at the domain root
  *[!A-Za-z0-9._-]*|""|*..*) echo "FATAL: SUBPATH must be a plain path segment (A-Za-z0-9._- and no '..') or '.'" >&2; exit 1 ;;
esac

# ── Self-logging: every run (timer or manual) appends to $BASE/update.log with
# a start banner, an OK/ABORTED end line, and the deployed commit + image id --
# so a silent abort or a tampered deploy is visible in one glance at the log,
# not just as mysteriously stale data. Size-rotated in place (no logrotate
# dependency); the log stays out of the build context (allowlist .dockerignore).
LOG="$BASE/update.log"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then mv -f "$LOG" "$LOG.1"; fi
exec > >(tee -a "$LOG") 2>&1
echo "=== update run started $(date -u +%FT%TZ) (podman, rootless) ==="
trap 'echo "=== ABORTED (exit $?) $(date -u +%FT%TZ) ==="' ERR

CHECKOUT="$BASE/$CHECKOUT_DIR"

# First run on a fresh server: clone the repo. Day-to-day: pull. A failed
# clone/pull aborts with the webroot untouched.
if [ ! -d "$CHECKOUT/.git" ]; then
  git clone "$REPO_URL" "$CHECKOUT"
fi
cd "$CHECKOUT"
git pull

cd "$BASE"
rm -rf css data index.html js tools tests
cp -r "$CHECKOUT_DIR"/* "$BASE/"
cp "$CHECKOUT_DIR/.dockerignore" "$BASE/"   # glob above skips dotfiles

# Refresh live data. Each exits non-zero if a validation guard trips, which
# aborts the deploy -- the committed data already in the image keeps serving.
# ORDER MATTERS: fetch_data first, because fetch_cape aligns its annual CAPE
# series to market-data's year axis -- running it second means both files come
# from the same morning's data (otherwise, each January the site would ship a
# market file with one more year than the CAPE file).
#
# The fetchers parse HTML from the internet -- the only untrusted input this
# host processes. Rootless already denies them privilege, so there is no UID to
# drop to; they still run in a throwaway staging dir (never in the webroot) and
# only the three expected outputs are copied back, refusing symlinks.
FETCHDIR="$(mktemp -d "${TMPDIR:-/tmp}/webswr-fetch.XXXXXX")"
trap 'rm -rf "$FETCHDIR"' EXIT
cp -r "$BASE/tools" "$BASE/data" "$FETCHDIR/"
rm -rf "$FETCHDIR/tools/.cache" # always fetch fresh; no stale cache in the sandbox
mkdir -p "$FETCHDIR/js"
cd "$FETCHDIR/tools"
python3 fetch_data.py --refresh
python3 fetch_cape.py --refresh
# Copy back ONLY the expected outputs, refusing symlinks -- nothing from the
# fetch stage may redirect a write into a file that is then served publicly.
cd "$BASE"
for f in js/market-data.js js/cape-data.js data/market-data.json; do
  if [ -h "$FETCHDIR/$f" ] || [ ! -f "$FETCHDIR/$f" ]; then
    echo "FATAL: fetch output $f is missing or not a regular file" >&2; exit 1
  fi
  cp "$FETCHDIR/$f" "$BASE/$f"
done

chmod 600 "$BASE/.env"

# Refresh images and rebuild on the freshly-pulled base while the old
# containers keep serving; a failed pull/build aborts here (set -e) with the
# running site untouched. --pull keeps the nginx base patched (without it the
# cached base would never update again: no CVE fixes). daemon-reload picks up
# any quadlet edits that arrived with this morning's git pull.
podman pull "$TUNNEL_IMAGE"
podman build --pull --build-arg SUBPATH="$SUBPATH" -t "$IMAGE_TAG" "$BASE"
systemctl --user daemon-reload
systemctl --user restart "$SITE_UNIT" "$TUNNEL_UNIT"

# Forensic record: what exactly is deployed right now (git commit + image ids).
# With the start/OK banners this makes the log a verifiable timeline of every
# change that reached production.
echo "deployed commit: $(git -C "$CHECKOUT" rev-parse HEAD)"
podman images --format '{{.Repository}}:{{.Tag}} {{.ID}}' \
  --filter "reference=$IMAGE_TAG" --filter "reference=$TUNNEL_IMAGE"

# Prune LAST, once the new containers are up and protecting their images.
# Rootless prune only touches this user's own image store -- other stacks on
# the host, podman or docker, are untouched.
podman system prune -f -a

echo "=== OK $(date -u +%FT%TZ) ==="
exit 0
}
