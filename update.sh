#!/bin/bash
# WebSWR daily deploy (root cron). Order is the failsafe: pull before touching
# the webroot, build the new image before pruning anything -- any failure
# aborts (set -e) and the running container keeps serving last-known-good.
# The braces make bash parse the whole file before executing any of it, so the
# cp below replacing this script mid-run can't corrupt this run.
#
# All deployment-specific values live in config.webswr (see
# config.webswr.example); this script carries no hardcoded paths, UIDs or
# names. It self-locates: the webroot is wherever config.webswr lives --
# either this script's own directory (webroot copy / fresh bootstrap) or its
# parent (the checkout copy that cron runs).
{
set -eEu

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# Parent first: when cron runs the CHECKOUT's copy, the webroot is the parent.
# (Also means a config.webswr accidentally committed into a fork's repo can
# never make the checkout itself masquerade as the webroot.)
if [ -f "$SELF_DIR/../config.webswr" ]; then BASE="$(cd "$SELF_DIR/.." && pwd)";
elif [ -f "$SELF_DIR/config.webswr" ]; then BASE="$SELF_DIR";
else
  echo "FATAL: config.webswr not found in $SELF_DIR or its parent." >&2
  echo "Copy config.webswr.example to the webroot as config.webswr and edit it" >&2
  echo "(it sits NEXT TO .env, above the git checkout). Nothing was changed." >&2
  exit 1
fi
# config.webswr is parsed as DATA, never sourced -- a config file should not
# be able to execute code, and a malformed line gets a clear FATAL instead of
# bash noise. KEY=value lines only; last assignment wins; CRLF tolerated.
cfg() { sed -n "s/^$1=//p" "$BASE/config.webswr" | tail -1 | tr -d '\r'; }
REPO_URL="$(cfg REPO_URL)"
CHECKOUT_DIR="$(cfg CHECKOUT_DIR)"
APP_UID="$(cfg APP_UID)"
TUNNEL_UID="$(cfg TUNNEL_UID)"
FETCH_UID="$(cfg FETCH_UID)"
STACK_NAME="$(cfg STACK_NAME)"
SUBPATH="$(cfg SUBPATH)"

# Validate BEFORE touching anything: a typo'd or missing value aborts here
# with the webroot untouched and the running site still serving.
[ -n "$REPO_URL" ] || { echo "FATAL: config.webswr must set REPO_URL" >&2; exit 1; }
case "$CHECKOUT_DIR" in
  *[!A-Za-z0-9._-]*|""|.|..|*..*) echo "FATAL: CHECKOUT_DIR must be a plain directory name (A-Za-z0-9._- and no '..')" >&2; exit 1 ;;
esac
case "$SUBPATH" in
  .) ;; # sanctioned: serve at the domain root
  *[!A-Za-z0-9._-]*|""|*..*) echo "FATAL: SUBPATH must be a plain path segment (A-Za-z0-9._- and no '..') or '.'" >&2; exit 1 ;;
esac
case "$STACK_NAME" in
  *[!A-Za-z0-9_-]*|"") echo "FATAL: STACK_NAME must be non-empty, characters A-Za-z0-9_-" >&2; exit 1 ;;
esac
case "$APP_UID" in
  *[!0-9]*|"") echo "FATAL: APP_UID must be numeric" >&2; exit 1 ;;
esac
case "$TUNNEL_UID" in
  *[!0-9]*|"") echo "FATAL: TUNNEL_UID must be numeric" >&2; exit 1 ;;
esac
case "$FETCH_UID" in
  *[!0-9]*|""|0) echo "FATAL: FETCH_UID must be a non-root numeric UID (65534 = nobody)" >&2; exit 1 ;;
esac
command -v setpriv >/dev/null || { echo "FATAL: setpriv (util-linux) is required to drop privileges for the data fetchers" >&2; exit 1; }
# docker compose reads these for variable substitution (user:, names, SUBPATH).
export APP_UID TUNNEL_UID STACK_NAME SUBPATH

# ── Self-logging: every run (cron or manual) appends to $BASE/update.log with
# a start banner, an OK/ABORTED end line, and the deployed commit + images --
# so a silent abort or a tampered deploy is visible in one glance at the log,
# not just as mysteriously stale data. Size-rotated in place (no logrotate
# dependency); the log stays out of the docker build context (allowlist).
LOG="$BASE/update.log"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then mv -f "$LOG" "$LOG.1"; fi
exec > >(tee -a "$LOG") 2>&1
echo "=== update run started $(date -u +%FT%TZ) ==="
trap 'echo "=== ABORTED (exit $?) $(date -u +%FT%TZ) ==="' ERR

CHECKOUT="$BASE/$CHECKOUT_DIR"

# First run on a fresh server: clone the repo. Day-to-day: pull. A failed
# clone/pull aborts with the webroot untouched. -c safe.directory is failure
# insurance: if a previous run died between the blanket $APP_UID chown and the
# root:root restore below, the checkout is left $APP_UID-owned and a plain
# root pull would refuse ("dubious ownership").
if [ ! -d "$CHECKOUT/.git" ]; then
  git clone "$REPO_URL" "$CHECKOUT"
fi
cd "$CHECKOUT"
git -c safe.directory="$CHECKOUT" pull

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
# PRIVILEGE DROP: the fetchers parse HTML fetched from the internet -- the only
# untrusted input this host processes -- so they must not run as root. They
# CANNOT run in place: the webroot sits under /root (0700), which $FETCH_UID
# rightly cannot traverse. Instead they run in a throwaway staging dir under
# /tmp owned by $FETCH_UID (mode 700: other stacks' UIDs can't peek either),
# and root copies back exactly the three expected output files afterwards.
# Net effect: the fetch UID can't even SEE the webroot -- stronger isolation
# than running them in place would give.
FETCHDIR="$(mktemp -d /tmp/webswr-fetch.XXXXXX)"
trap 'rm -rf "$FETCHDIR"' EXIT
cp -r "$BASE/tools" "$BASE/data" "$FETCHDIR/"
rm -rf "$FETCHDIR/tools/.cache" # always fetch fresh; no stale cache in the sandbox
mkdir -p "$FETCHDIR/js"
chown -R "$FETCH_UID:$FETCH_UID" "$FETCHDIR"
cd "$FETCHDIR/tools"
setpriv --reuid="$FETCH_UID" --regid="$FETCH_UID" --clear-groups --no-new-privs python3 fetch_data.py --refresh
setpriv --reuid="$FETCH_UID" --regid="$FETCH_UID" --clear-groups --no-new-privs python3 fetch_cape.py --refresh
# No fetch-UID stragglers may outlive the fetch (a compromised fetcher could
# fork and try to race the copy-back below).
pkill -U "$FETCH_UID" 2>/dev/null || true
# Copy back ONLY the expected outputs, refusing symlinks -- root must never
# dereference a link planted by the (untrusted) fetch stage into a file that
# would then be served publicly.
cd "$BASE"
for f in js/market-data.js js/cape-data.js data/market-data.json; do
  if [ -h "$FETCHDIR/$f" ] || [ ! -f "$FETCHDIR/$f" ]; then
    echo "FATAL: fetch output $f is missing or not a regular file" >&2; exit 1
  fi
  cp "$FETCHDIR/$f" "$BASE/$f"
done

cd "$BASE"
chown -R "$APP_UID:$APP_UID" ./*   # match the website container's user (config.webswr)
chown root:root .env config.webswr
chmod 600 .env
chown root:root update.sh docker-compose.yaml Dockerfile
chown -R root:root "$CHECKOUT_DIR"

# Refresh images and rebuild on the freshly-pulled base while the old
# containers keep serving; a failed pull aborts here (set -e) with the
# running site untouched. Without --pull the cached nginx/cloudflared bases
# would never update again (no CVE fixes, and Cloudflare eventually drops
# old cloudflared versions). Prune only after the new containers are up --
# pruning first could leave zero images to fall back on.
docker compose pull
docker compose build --pull
docker compose up -d

# Forensic record: what exactly is deployed right now (git commit + the image
# ids the containers were created from). With the start/OK banners this makes
# the log a verifiable timeline of every change that reached production.
echo "deployed commit: $(git -C "$CHECKOUT" rev-parse HEAD)"
docker compose images

docker system prune -f -a

echo "=== OK $(date -u +%FT%TZ) ==="
exit 0
}
