#!/bin/bash
# WebSWR daily deploy (root cron). Order is the failsafe: pull before touching
# the webroot, build the new image before pruning anything -- any failure
# aborts (set -e) and the running container keeps serving last-known-good.
# The braces make bash parse the whole file before executing any of it, so the
# cp below replacing this script mid-run can't corrupt this run.
{
set -eu

# Sync the checkout first; a failed pull aborts with the webroot untouched.
# -c safe.directory lets root pull in the jordanp123-owned checkout.
cd /home/jordanp123/webswr/Trimor
git -c safe.directory=/home/jordanp123/webswr/Trimor pull

cd /home/jordanp123/webswr
rm -rf css data index.html js tools tests
cp -r Trimor/* /home/jordanp123/webswr/
cp Trimor/.dockerignore /home/jordanp123/webswr/   # glob above skips dotfiles

# Refresh live data. Each exits non-zero if a validation guard trips, which
# aborts the deploy -- the committed data already in the image keeps serving.
cd /home/jordanp123/webswr/tools
python3 fetch_cape.py --refresh
python3 fetch_data.py --refresh

cd /home/jordanp123/webswr
chown -R 7001:7001 *
chown root:root .env
chmod 600 .env
chown jordanp123:jordanp123 update.sh docker-compose.yaml Dockerfile
chown -R jordanp123:jordanp123 Trimor

# Build while the old container serves, swap, then clean up. Never prune
# before the new image exists: with no image on disk, a bad pull from Docker
# Hub would leave nothing to fall back on and the site down.
docker compose up -d --build
docker system prune -f

exit 0
}
