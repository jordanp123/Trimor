# WebSWR — rootless Podman deployment

Everything needed to run WebSWR under **rootless Podman** with systemd
[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
units: containers become real user services with boot ordering,
restart-on-failure, journald logs and a daily auto-update timer. `install.sh`
does the wiring.

The repo root also ships a Docker Compose deployment (`docker-compose.yaml` +
`update.sh`). **This directory is the Podman path** — you want one or the other,
not both running at once.

**Why rootless:** the container hardening is identical either way (read-only
rootfs, all capabilities dropped, no-new-privileges, non-root user,
internal-only network for nginx). The gain is that no root-owned daemon is in
the path and **the daily update job stops running as root** — so a compromise of
your git remote or the data pipeline lands as one unprivileged user instead of
root. This stack is an easy rootless fit because it **publishes no ports** (the
tunnel dials out), so there is no bind-below-1024 problem.

Requires **Podman 5+**, cgroups v2, and a subuid range covering your `APP_UID`
(the default 65536-wide range in `/etc/subuid` covers the stock 17001).

> **Status: contributed, not battle-tested.** The maintained deployment is the
> Docker one. These files mirror it directive-for-directive, and both scripts
> were dry-run end to end with `podman`/`systemctl` stubbed — but the real
> podman path has not been exercised in CI. Please open an issue if something
> needs adjusting.

## Layout

```
deploy/
  install.sh                     installs + wires everything (run this)
  quadlet/                       -> ~/.config/containers/systemd/
    webswr-backend.network         internal-only network (nginx: no egress)
    webswr-egress.network          outbound network (tunnel only)
    webswr-website.build           builds the site image from the webroot
    webswr-website.container       nginx service
    webswr-cloudflared.container   tunnel service
  systemd/                       -> ~/.config/systemd/user/
    webswr-update.service          the daily refresh
    webswr-update.timer            05:00 + up to 15m jitter, catches up if missed
  bin/
    webswr-update.sh             -> ~/.local/bin/
```

Units are prefixed `webswr-` because Quadlet units are flat and per-user —
generic names would collide with another project's units on the same host.

## Install

```sh
# 1. Webroot: holds config.webswr and (after the first update) the assembled
#    site. The git checkout lives inside it.
mkdir -p ~/webswr && cd ~/webswr
git clone https://github.com/jordanp123/Trimor.git
cp Trimor/config.webswr.example config.webswr    # edit if you want non-stock values

# 2. Install the units, timer and updater
./Trimor/deploy/install.sh
```

Then follow the **Next steps** it prints: create the tunnel-token secret, enable
lingering, run the updater once (it assembles the webroot, fetches data, builds
and starts everything), and enable the timer.

`install.sh` is safe to re-run — after editing a unit, pulling a new version, or
moving the webroot. Flags: `--yes` to accept the detected webroot, `--base-dir
PATH` (or `WEBSWR_BASE=PATH`) to point elsewhere, `--help` for usage.

**It does the interpolation Quadlet can't.** Quadlet files are systemd units, so
they don't expand `${VAR}`. `install.sh` reads your `config.webswr` once and
writes `APP_UID`, `TUNNEL_UID`, `STACK_NAME` and `SUBPATH` into the units, plus
rewrites the `%h/webswr` placeholder to your real webroot. `config.webswr` stays
the single source of truth for both deployments; nothing is hand-edited.

## Migrating an existing Docker deployment

The safe path, because **two cloudflared connectors on one tunnel token is a
supported HA configuration** and both stacks serve byte-identical content: run
them side by side, verify, then retire Docker. Nothing is destructive until the
last step, and rollback is one command throughout.

**1. Create the deploy user** (leave `/root/webswr` untouched):

```sh
sudo useradd -m -s /bin/bash webswr
sudo loginctl enable-linger webswr
```

**2. Copy — don't move — the webroot:**

```sh
sudo cp -a /root/webswr /home/webswr/webswr
sudo chown -R webswr:webswr /home/webswr/webswr
```

**3. As the new user, move the token into a podman secret and install:**

```sh
sudo -iu webswr
sed -n 's/^TUNNEL_TOKEN=//p' ~/webswr/.env | tr -d '\r\n' \
  | podman secret create webswr-tunnel-token -
podman secret ls
~/webswr/Trimor/deploy/install.sh --yes
systemctl --user start webswr-update.service     # assembles, builds, starts
journalctl --user -u webswr-cloudflared -n 30    # expect a second connector to register
```

Docker keeps serving throughout; traffic simply splits between the two
connectors.

**4. Prove the Podman side is really serving** by stopping Docker briefly:

```sh
cd /root/webswr && sudo docker compose stop
curl -sI https://your.domain/webswr/ | head -1
```

Anything wrong? `sudo docker compose start` restores in seconds.

**5. Enable the timer and remove the root cron line:**

```sh
systemctl --user enable --now webswr-update.timer
sudo crontab -e     # delete the old update.sh line
```

**6. After a few clean days**, retire Docker: `sudo docker compose down` in
`/root/webswr`, then remove the old webroot (and its `.env`, once you are sure
the secret is working).

**Rollback** at any point before step 6: `systemctl --user stop
webswr-website.service webswr-cloudflared.service`, then `docker compose up -d`
in `/root/webswr`. The original webroot, `.env` and cron line are all still
intact — that is why step 2 copies rather than moves.

Two side effects worth knowing: rootless `podman system prune` only touches that
user's own image store, so this stack **stops sweeping other stacks'** stopped
containers the way the host-wide `docker system prune -a` did; and the daily job
no longer runs as root.

## The daily refresh

`bin/webswr-update.sh` is the rootless counterpart of the repo-root `update.sh`:
same `config.webswr` parsing and validation, same logging (start banner,
`ABORTED` line with exit code, deployed commit + image ids, size-rotated
`update.log` in the webroot), same fetch ordering and symlink-guarded copy-back.
It differs only where rootless requires it — no `setpriv`, no `chown` — and it
**rolls back to the previous image** if a fresh build starts but the container
fails to come up. It refuses to run as root.

```sh
systemctl --user start webswr-update.service      # run it now
journalctl --user -u webswr-update -f             # watch
systemctl --user list-timers webswr-update.timer  # when is it next due?
```

Run it directly with `WEBSWR_BASE=/path/to/webroot ~/.local/bin/webswr-update.sh`
if your webroot is not `~/webswr` (the timer needs nothing extra — the unit
carries the path).

## The tunnel token

The Docker deployment keeps the token in `.env`. The Podman units read a
**podman secret** instead, injected as `TUNNEL_TOKEN` at container start — the
same variable cloudflared already reads, so nothing about its consumption
changes.

What this actually buys, stated honestly:

- The token **leaves the deploy directory**. It is no longer in the webroot, the
  build context, a backup of either, or in any unit file — the realistic ways a
  secret in a project directory escapes.
- Rotation and inventory become managed operations (`podman secret ls`,
  `inspect`, `rm`) instead of hand-editing a dotfile.
- `webswr-update.sh` fails fast with instructions if the secret is missing,
  rather than letting the tunnel container fail to start later.

What it does **not** buy: podman's default secret driver stores secrets
base64-encoded in the user's container storage — **not encrypted**. Anyone who
can read that user's files (or is root) can still recover the token. This is
better scoping and hygiene, not encryption at rest. For real at-rest protection,
point podman at an external driver (e.g. `pass` or a KMS).

**Rotation** — after issuing a new token in the Cloudflare dashboard:

```sh
podman secret rm webswr-tunnel-token
printf '%s' 'NEW-TOKEN' | podman secret create webswr-tunnel-token -
systemctl --user restart webswr-cloudflared.service
journalctl --user -u webswr-cloudflared -n 20
```

Always `printf '%s'`, never `echo`: a trailing newline is stored verbatim and
cloudflared rejects the token with a confusing auth error.

## Gotchas

- **Tunnel DNS name.** Compose resolved the site as both `website` (service
  name) and `WebSWR` (container name). `webswr-website.container` sets
  `NetworkAlias=website` so both keep working — point your tunnel's ingress rule
  at one of them on port 8080 (e.g. `http://website:8080`).
- **Rootless `--cpus`** needs cgroups v2 CPU delegation. If the container fails
  to start citing cgroups, drop `--cpus=1` from `PodmanArgs=`; the memory and
  pids limits work regardless.
- **`AutoUpdate=registry`** on the tunnel only marks it eligible for `podman
  auto-update`. `webswr-update.timer` doesn't run that — the updater pulls the
  tunnel image explicitly every night. To cover *every* container on the host,
  also enable podman's own timer (it ships disabled):
  `systemctl --user enable --now podman-auto-update.timer`.
- **The `.build` unit** exists so a cold `systemctl --user start
  webswr-website.service` works without a manual build. The updater rebuilds the
  same tag with `--pull` each morning, which is what keeps the nginx base image
  patched.
- **SELinux** (Fedora/RHEL): these units mount no host volumes, so the usual
  `:z`/`:Z` relabeling issue does not arise.
- **Rootful Podman** works too: put the units in `/etc/containers/systemd/`, use
  `systemctl` without `--user`, and adjust the updater (it refuses to run as
  root as shipped). You keep the systemd integration but lose the rootless
  benefit that motivates this setup.

## Just want it running?

`podman compose up -d` (or `podman-compose`) will usually run the repo's
`docker-compose.yaml` unchanged. That is the quickest path; this directory is
the more idiomatic, systemd-native destination.
