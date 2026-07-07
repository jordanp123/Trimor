#!/bin/sh
# WebSWR daily deploy: sync to GitHub, refresh the CAPE data, rebuild, redeploy.
# Run on the server from cron, e.g.:
#   17 6 * * * cd $HOME/webswr && flock -n .deploy.lock sh deploy/update.sh >> $HOME/webswr-update.log 2>&1
#
# Fail-safe by design: `set -e` aborts the chain on the FIRST failure -- a bad
# pull, a tripped data-pipeline guard, or a failed build all leave the currently
# running container serving last-known-good data. deploy/.env (the tunnel token)
# is untracked, so the hard reset below never touches it.
#
# The braces force the shell to parse this whole file before executing any of
# it, so a `git reset` replacing the script mid-run can't corrupt this run.
{
set -eu
cd "$(dirname "$0")/.."
echo "=== $(date -u '+%F %TZ') update start ==="

# This box is a pure consumer of the repo: discard the locally regenerated data
# files from yesterday's run and take exactly what's on origin/main.
git fetch origin
git reset --hard origin/main

# Refresh the current CAPE (exits non-zero if any validation guard trips).
timeout 300 python3 tools/fetch_cape.py --refresh

docker compose -f deploy/docker-compose.yml up -d --build
docker image prune -f >/dev/null   # drop dangling layers from daily rebuilds

echo "=== $(date -u '+%F %TZ') update OK ==="
exit 0
}
