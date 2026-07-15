#!/bin/bash
# WebSWR daily deploy (root cron). Order is the failsafe: pull before touching
# the webroot, build the new image before pruning anything -- any failure
# aborts (set -e) and the running container keeps serving last-known-good.
# The braces make bash parse the whole file before executing any of it, so the
# cp below replacing this script mid-run can't corrupt this run.
{
set -eu

# Sync the checkout first; a failed pull aborts with the webroot untouched.
# -c safe.directory is failure insurance: if a previous run died between the
# blanket 17001 chown and the root:root restore below, the checkout is left
# 17001-owned and a plain root pull would refuse ("dubious ownership").
cd /root/webswr/Trimor
git -c safe.directory=/root/webswr/Trimor pull

cd /root/webswr
rm -rf css data index.html js tools tests
cp -r Trimor/* /root/webswr/
cp Trimor/.dockerignore /root/webswr/   # glob above skips dotfiles

# Refresh live data. Each exits non-zero if a validation guard trips, which
# aborts the deploy -- the committed data already in the image keeps serving.
# ORDER MATTERS: fetch_data first, because fetch_cape aligns its annual CAPE
# series to market-data's year axis -- running it second means both files come
# from the same morning's data (otherwise, each January the site would ship a
# market file with one more year than the CAPE file).
cd /root/webswr/tools
python3 fetch_data.py --refresh
python3 fetch_cape.py --refresh

cd /root/webswr
chown -R 17001:17001 *  # match the website container's user in docker-compose.yaml
chown root:root .env
chmod 600 .env
chown root:root update.sh docker-compose.yaml Dockerfile
chown -R root:root Trimor

# Refresh images and rebuild on the freshly-pulled base while the old
# containers keep serving; a failed pull aborts here (set -e) with the
# running site untouched. Without --pull the cached nginx/cloudflared bases
# would never update again (no CVE fixes, and Cloudflare eventually drops
# old cloudflared versions). Prune only after the new containers are up --
# pruning first could leave zero images to fall back on.
docker compose pull
docker compose build --pull
docker compose up -d
docker system prune -f -a

exit 0
}
