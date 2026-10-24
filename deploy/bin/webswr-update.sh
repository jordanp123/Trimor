#!/bin/bash
# WebSWR daily deploy -- ROOTLESS PODMAN variant of the repo-root update.sh.
# Installed to ~/.local/bin by deploy/install.sh and driven by
# webswr-update.timer. Run it as the unprivileged deploy user, never as root.
# Requires Podman 5+ and the quadlet units from deploy/quadlet/ installed.
#
# Where is the webroot? $WEBSWR_BASE (which webswr-update.service sets from
# whatever path install.sh detected), else ~/webswr. The webroot holds
# config.webswr and the assembled site; the git checkout lives inside it. If
# your webroot is NOT ~/webswr, invoke it by hand as:
#   WEBSWR_BASE=/path/to/webroot webswr-update.sh
# (timer runs need nothing extra -- the unit carries the path.)
#
# Same failsafe ordering as the Docker script: verify and update the checkout
# before touching the webroot (only commits signed by a key in
# ~/.config/webswr/allowed_signers deploy -- see the signed-commit gate below),
# build the new image before pruning anything -- any failure aborts (set -e) and
# the running containers keep serving last-known-good. If the new image starts
# but the container fails to come up, the previous image is restored. The braces
# make bash parse the whole file before executing any of it, so the cp below
# replacing this script mid-run can't corrupt this run.
#
# Differences from the Docker variant, all consequences of being rootless:
#   * no setpriv privilege drop and no chowns -- the whole script already runs
#     unprivileged, and an unprivileged user cannot switch UIDs anyway. The
#     fetchers keep their throwaway staging dir and symlink-guarded copy-back.
#   * APP_UID / TUNNEL_UID / STACK_NAME are not read here: quadlet files are
#     systemd units and do not expand ${VAR}, so deploy/install.sh writes those
#     values into the units once, from the same config.webswr.
#   * `docker compose up -d` becomes `podman build` + `systemctl --user restart`.
{
set -eEu

# Unit names, matching the quadlet filenames in deploy/quadlet/.
SITE_UNIT="webswr-website.service"
TUNNEL_UNIT="webswr-cloudflared.service"
IMAGE_TAG="localhost/webswr-website:latest"
ROLLBACK_TAG="localhost/webswr-website:previous"
TUNNEL_IMAGE="docker.io/cloudflare/cloudflared:latest"
# Podman secret holding the Cloudflare tunnel token (see the cloudflared unit).
SECRET_NAME="webswr-tunnel-token"

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
# Fail here rather than letting the tunnel container fail to start later.
podman secret inspect "$SECRET_NAME" >/dev/null 2>&1 || {
  echo "FATAL: podman secret '$SECRET_NAME' does not exist. Create it with:" >&2
  echo "  printf '%s' 'YOUR-TUNNEL-TOKEN' | podman secret create $SECRET_NAME -" >&2
  echo "(printf, not echo -- a trailing newline would corrupt the token.)" >&2
  exit 1
}

# webswr-update.service sets WEBSWR_BASE; ~/webswr is the standard layout.
BASE="${WEBSWR_BASE:-$HOME/webswr}"
[ -d "$BASE" ] || { echo "FATAL: webroot $BASE does not exist (set WEBSWR_BASE)" >&2; exit 1; }
BASE="$(cd "$BASE" && pwd)"
[ -f "$BASE/config.webswr" ] || {
  echo "FATAL: no config.webswr in $BASE." >&2
  echo "Copy config.webswr.example there and edit it, or point WEBSWR_BASE at" >&2
  echo "the right webroot. Nothing was changed." >&2
  exit 1
}

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
# Owner-only: the log carries paths, commit ids and image ids, and a host that
# runs several stacks has other service accounts that have no business reading
# them. Create it before the redirect so `tee` never makes it 0644 first.
[ -f "$LOG" ] || : > "$LOG"
chmod 600 "$LOG" "$LOG.1" 2>/dev/null || true
exec > >(tee -a "$LOG") 2>&1
echo "=== update run started $(date -u +%FT%TZ) (podman, rootless) ==="
trap 'echo "=== ABORTED (exit $?) $(date -u +%FT%TZ) ==="' ERR

CHECKOUT="$BASE/$CHECKOUT_DIR"

# >>> signed-commit gate ------------------------------------------------------
# Byte-identical in update.sh and deploy/bin/webswr-update.sh: deploy_parity.py
# fails the suite if the two copies drift, and signed_deploy_test.sh runs this
# exact text against real signed, unsigned and foreign-signed commits.
#
# Why: this job deploys whatever the GitHub repo's branch holds, so without a
# check a stolen GitHub login would reach every visitor by the next morning. A
# signature from a key the operator listed proves a commit came from the
# operator's own machine, whoever controls the GitHub account.
#
# The trust list (allowed_signers, one key per line) lives OUTSIDE the webroot
# and the checkout, so no commit -- signed or not -- can edit it. Every check
# runs BEFORE the checkout moves: any doubt aborts the run, and the site keeps
# serving the last build that passed.

# check_signers FILE -- refuse to deploy without a trust list we can rely on.
check_signers() {
  local f="$1" v p
  command -v ssh-keygen >/dev/null || {
    echo "FATAL: ssh-keygen (OpenSSH) is required to verify commit signatures" >&2; return 1; }
  v="$(git --version | sed -n 's/^git version \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1.\2/p')"
  case "$v" in
    ""|1.*|2.[0-9]|2.[12][0-9]|2.3[0-3])
      echo "FATAL: git ${v:-(unknown version)} cannot verify SSH commit signatures; 2.34+ is required" >&2
      return 1 ;;
  esac
  if [ -h "$f" ]; then
    echo "FATAL: $f is a symlink -- the trusted-signer list must be a regular file" >&2; return 1
  fi
  if [ ! -f "$f" ]; then
    echo "FATAL: no trusted-signer list at $f -- refusing to deploy." >&2
    echo "  Every deployed commit must be signed by a key listed there. Add one line per" >&2
    echo "  signer, built from the PUBLIC half of the key that signs your commits:" >&2
    echo "    you@example.com namespaces=\"git\" ssh-ed25519 AAAA..." >&2
    echo "  See \"Signed commits\" in deploy/README.md." >&2
    return 1
  fi
  # Anyone who can edit the list can deploy, so the file and its directory
  # must belong to this account (or root) and be writable by no one else.
  for p in "$f" "$(dirname "$f")"; do
    case "$(ls -ldn "$p" | awk '{print $3}')" in
      "$(id -u)"|0) ;;
      *) echo "FATAL: $p belongs to another user, who could change who may deploy" >&2; return 1 ;;
    esac
    case "$(ls -ld "$p" | cut -c6,9)" in
      *w*) echo "FATAL: $p is writable by other users -- chmod go-w $p" >&2; return 1 ;;
    esac
  done
  grep -q '^[^#[:space:]]' "$f" || {
    echo "FATAL: $f lists no keys, so every commit would be refused" >&2; return 1; }
}

# verify_commits FILE COMMIT... -- fail unless EVERY commit carries a valid
# signature from a key listed in FILE. Current git already refuses a good
# signature from an unlisted key; minTrustLevel=fully insists on a listed one
# whatever this git version's defaults or a host-wide setting say.
verify_commits() {
  local f="$1" c why
  shift
  for c in "$@"; do
    if ! git -c gpg.ssh.allowedSignersFile="$f" -c gpg.minTrustLevel=fully \
         verify-commit "$c" >/dev/null 2>&1; then
      case "$(git -c gpg.ssh.allowedSignersFile="$f" log -1 --format='%G?' "$c")" in
        N) why="is not signed" ;;
        U) why="is signed by a key that is not in $f" ;;
        B) why="has a BAD signature (changed after it was signed?)" ;;
        X|Y|R) why="is signed by an expired or revoked key" ;;
        *) why="has a signature that could not be checked" ;;
      esac
      echo "FATAL: commit $c $why -- refusing to deploy" >&2
      return 1
    fi
  done
}

# sync_verified_checkout REPO_URL DIR FILE -- move the checkout DIR up to its
# upstream ONLY if every commit that adds is signed by a key in FILE; otherwise
# leave it exactly where it was and fail. Every step is checked explicitly
# rather than left to set -e, which bash silently switches off inside a
# function called from if/&&/|| -- a gate must not depend on how it is called.
sync_verified_checkout() {
  local url="$1" dir="$2" f="$3"
  if [ ! -d "$dir/.git" ]; then
    # First run: clone beside DIR and verify the tip before it can become the
    # checkout. A refused clone -- or a run killed halfway -- must never be
    # mistaken next time for a baseline that was already deployed.
    rm -rf "$dir.unverified" || return 1
    git clone --quiet "$url" "$dir.unverified" || return 1
    if ! (cd "$dir.unverified" && verify_commits "$f" HEAD); then
      rm -rf "$dir.unverified"
      return 1
    fi
    mv "$dir.unverified" "$dir" || return 1
    echo "signed-commit gate: first clone, tip $(git -C "$dir" rev-parse --short HEAD) verified"
    return 0
  fi
  (
    cd "$dir" || exit 1
    git fetch --quiet || exit 1
    new="$(git rev-parse --verify --quiet '@{upstream}^{commit}')" || {
      echo "FATAL: the checkout's branch has no upstream to deploy from" >&2; exit 1; }
    # A rewritten history (a force-push, or commits made in the checkout) is
    # refused outright rather than reconciled: it needs a human to look at it.
    git merge-base --is-ancestor HEAD "$new" || {
      echo "FATAL: upstream no longer contains the deployed commit $(git rev-parse --short HEAD) -- refusing rewritten history" >&2
      exit 1; }
    # Every commit since the deployed one, not just the tip: a foreign commit
    # stays refused even after a signed commit lands on top of it.
    commits="$(git rev-list "HEAD..$new")" || exit 1
    verify_commits "$f" $commits || exit 1
    git merge --ff-only --quiet "$new" || exit 1
    set -- $commits
    if [ $# -eq 0 ]; then
      echo "signed-commit gate: no new commits; staying at $(git rev-parse --short HEAD)"
    else
      echo "signed-commit gate: $# new commit(s), all signed by a trusted key; now at $(git rev-parse --short HEAD)"
    fi
  )
}
# <<< signed-commit gate ------------------------------------------------------

# The trust list sits with this account's other config, outside the webroot.
SIGNERS="$HOME/.config/webswr/allowed_signers"
check_signers "$SIGNERS"
sync_verified_checkout "$REPO_URL" "$CHECKOUT" "$SIGNERS"

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

# The tunnel token lives in a podman secret, so .env is not required here. Keep
# a leftover one locked down anyway (an `if` -- not `&&` -- so a missing file
# doesn't trip set -e).
if [ -f "$BASE/.env" ]; then chmod 600 "$BASE/.env"; fi

# Refresh images and rebuild on the freshly-pulled base while the old
# containers keep serving; a failed pull/build aborts here (set -e) with the
# running site untouched. --pull keeps the nginx base patched (without it the
# cached base would never update again: no CVE fixes). daemon-reload picks up
# any quadlet edits that arrived with this morning's verified update.
podman pull "$TUNNEL_IMAGE"
# Keep the currently-deployed image so a bad build can be rolled back. (Ignore
# failure: on the very first run there is nothing to tag yet.)
podman tag "$IMAGE_TAG" "$ROLLBACK_TAG" 2>/dev/null || true
podman build --pull --build-arg SUBPATH="$SUBPATH" -t "$IMAGE_TAG" "$BASE"
systemctl --user daemon-reload

# If the new image builds but the container won't come up, put the previous
# image back rather than leaving the site down until someone notices.
if ! systemctl --user restart "$SITE_UNIT"; then
  echo "!! $SITE_UNIT failed to start on the new image" >&2
  if podman image exists "$ROLLBACK_TAG"; then
    echo "!! rolling back to the previous image" >&2
    podman tag "$ROLLBACK_TAG" "$IMAGE_TAG"
    systemctl --user restart "$SITE_UNIT" || true
  fi
  systemctl --user --no-pager --lines=20 status "$SITE_UNIT" >&2 || true
  exit 1
fi
systemctl --user restart "$TUNNEL_UNIT"

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
