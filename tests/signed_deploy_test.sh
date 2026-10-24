#!/bin/bash
# Signed-commit gate: run the EXACT gate text from both deploy scripts against
# real repositories -- commits signed by a trusted key, unsigned commits, and
# commits signed by a key that is not on the list -- and prove that only the
# first kind can ever reach the checkout the site is built from.
#
# Everything happens in a throwaway directory with the user's own git config,
# hooks and ssh-agent shut out; the keys are generated fresh on every run.
# The gate functions run WITHOUT set -e (each call sits in an `if`, where bash
# would ignore it anyway), so a missing explicit check shows up here as a
# commit that slipped through.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok()  { echo "  ok: $1"; }
bad() { echo "  FAIL: $1"; fails=$((fails + 1)); }
# expect pass|fail LABEL COMMAND... -- run COMMAND, compare its outcome.
expect() {
  local want="$1" label="$2" got
  shift 2
  if "$@" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then ok "$label"; else bad "$label (expected $want, got $got)"; fi
}

for tool in git ssh-keygen; do
  command -v "$tool" >/dev/null || { echo "  FAIL: $tool is not installed"; exit 1; }
done

T=$(mktemp -d "${TMPDIR:-/tmp}/webswr-gate.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
unset SSH_AUTH_SOCK
export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config"
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=gate GIT_AUTHOR_EMAIL=gate@example.invalid
export GIT_COMMITTER_NAME=gate GIT_COMMITTER_EMAIL=gate@example.invalid
mkdir -p "$HOME" && : > "$GIT_CONFIG_GLOBAL"

ssh-keygen -q -t ed25519 -N '' -C trusted -f "$T/trusted" || exit 1
ssh-keygen -q -t ed25519 -N '' -C stranger -f "$T/stranger" || exit 1
mkdir -p "$T/trust" && chmod 755 "$T/trust"
SIGNERS="$T/trust/allowed_signers"
printf 'deploy@example.invalid namespaces="git" %s\n' "$(cat "$T/trusted.pub")" > "$SIGNERS"
chmod 644 "$SIGNERS"

# Upstream stand-in: a plain repo the checkout clones and fetches from.
UP=""
commit() { # commit trusted|stranger|unsigned MESSAGE
  if [ "$1" = unsigned ]; then
    git -C "$UP" commit -q --allow-empty --no-gpg-sign -m "$2"
  else
    git -C "$UP" -c gpg.format=ssh -c user.signingkey="$T/$1" commit -q --allow-empty -S -m "$2"
  fi
}
at_head() { # at_head DIR SHA LABEL -- the checkout must sit exactly at SHA
  if [ "$(git -C "$1" rev-parse HEAD 2>/dev/null)" = "$2" ]; then ok "$3"; else bad "$3"; fi
}

for script in update.sh deploy/bin/webswr-update.sh; do
  echo "  -- the gate as written in $script"
  unset -f check_signers verify_commits sync_verified_checkout
  block=$(sed -n '/^# >>> signed-commit gate/,/^# <<< signed-commit gate/p' "$ROOT/$script")
  if [ -z "$block" ]; then bad "$script has no signed-commit gate block"; continue; fi
  eval "$block"

  W="$T/run-$(basename "$script")"
  UP="$W/upstream"
  CO="$W/site/Trimor"
  mkdir -p "$W/site"
  git init -q -b main "$UP"

  # --- the trust list itself
  expect pass "a private, non-empty trust list is accepted" check_signers "$SIGNERS"
  expect fail "a missing trust list refuses the deploy" check_signers "$W/missing"
  ln -s "$SIGNERS" "$W/linked"
  expect fail "a symlinked trust list is refused" check_signers "$W/linked"
  cp "$SIGNERS" "$W/groupw" && chmod 664 "$W/groupw"
  expect fail "a group-writable trust list is refused" check_signers "$W/groupw"
  mkdir "$W/open" && chmod 777 "$W/open" && cp "$SIGNERS" "$W/open/allowed_signers"
  expect fail "a trust list in a world-writable directory is refused" check_signers "$W/open/allowed_signers"
  printf '# no keys yet\n' > "$W/nokeys"
  expect fail "a trust list with no keys is refused" check_signers "$W/nokeys"

  # --- first clone: verified at the tip before it may become the checkout
  commit unsigned "unsigned root"
  expect fail "first clone: an unsigned tip is refused" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  if [ ! -e "$CO" ] && [ ! -e "$CO.unverified" ]; then
    ok "...and leaves neither a checkout nor a half-made clone behind"
  else
    bad "...a refused first clone left something behind"
  fi
  commit stranger "foreign tip"
  expect fail "first clone: a tip signed by an unlisted key is refused" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  [ ! -e "$CO" ] && ok "...and still no checkout exists" || bad "...a foreign-signed clone became the checkout"
  commit trusted "signed tip"
  expect pass "first clone: a tip signed by a trusted key is accepted" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  at_head "$CO" "$(git -C "$UP" rev-parse HEAD)" "...and the checkout sits at that tip"

  # --- day-to-day runs
  expect pass "no new commits: the nightly run still proceeds (data refresh)" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  commit trusted "signed update"
  expect pass "a signed update is accepted" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  at_head "$CO" "$(git -C "$UP" rev-parse HEAD)" "...and the checkout moves to it"
  good=$(git -C "$CO" rev-parse HEAD)

  commit unsigned "unsigned change"
  expect fail "an unsigned commit is refused" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  at_head "$CO" "$good" "...and the checkout does not move"
  commit trusted "signed commit on top"
  expect fail "a signed commit on top does not launder the unsigned one beneath it" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  at_head "$CO" "$good" "...and the checkout still does not move"

  git -C "$UP" reset -q --hard "$good"
  commit stranger "foreign change"
  expect fail "a commit signed by an unlisted key is refused" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  at_head "$CO" "$good" "...and the checkout does not move"

  # A force-pushed history: a SIGNED tip that no longer contains the deployed commit.
  git -C "$UP" checkout -q --orphan rewritten
  commit trusted "rewritten history"
  git -C "$UP" branch -q -M main
  expect fail "a rewritten history is refused even when its tip is signed" sync_verified_checkout "$UP" "$CO" "$SIGNERS"
  at_head "$CO" "$good" "...and the checkout does not move"
done

echo "SIGNED-COMMIT GATE: $([ "$fails" -eq 0 ] && echo "all checks passed" || echo "$fails FAILED")"
[ "$fails" -eq 0 ]
