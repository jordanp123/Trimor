# Running WebSWR under Podman (rootless quadlets)

An alternative to `docker-compose.yaml` for Podman users, plus a step-by-step
conversion guide for an existing Docker deployment. These are
[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
units — systemd generates real services from them, so the stack gets boot
ordering, restart-on-failure and journald logs for free.

**Why bother:** the container hardening here is identical to the compose stack
(read-only rootfs, all capabilities dropped, no-new-privileges, non-root user,
internal-only network for nginx). The gain is **rootless operation**: no root
daemon, container UIDs map to unprivileged host UIDs, and — the big one — the
daily update job stops running as root, so a compromise of your git remote or
the data pipeline lands as one unprivileged user instead of root.

This stack is a good rootless fit because it **publishes no ports** (Cloudflare
reaches it through the tunnel's outbound connection), so there's no
bind-below-1024 problem to solve.

Requires **Podman 5+** and cgroups v2.

> **Status: contributed, not battle-tested.** The maintained deployment is the
> Docker one. These files mirror it directive-for-directive, and `update.sh`
> here was dry-run end to end with `podman`/`systemctl` stubbed — but the real
> podman path has not been exercised in CI. Please open an issue if something
> needs adjusting.

## Files

| File | Compose equivalent |
| --- | --- |
| `webswr.build` | `build:` + `args:` |
| `webswr.container` | the `website` service |
| `webswr-tunnel.container` | the `cloudflare_tunnel` service |
| `webswr-backend.network` | `networks: backend: {internal: true}` |
| `webswr-egress.network` | `networks: egress` |
| `update.sh` | the repo-root `update.sh`, rootless |

Values in the units are the stock defaults. If you edited `config.webswr`,
mirror the matching values here (`STACK_NAME` → `ContainerName=`,
`APP_UID`/`TUNNEL_UID` → `User=`/`Group=`, `SUBPATH` → the `BuildArg=`).
Quadlet files are systemd units, so they do **not** expand `${VAR}` the way
compose does — the values are literal. `update.sh` still reads `config.webswr`
for `REPO_URL`, `CHECKOUT_DIR` and `SUBPATH`; `FETCH_UID` goes unused (rootless
has no privilege left to drop).

## Fresh install

Prerequisites: a subuid range covering your `APP_UID` — the default 65536-wide
range in `/etc/subuid` covers the stock 17001 fine (`grep "^$USER:" /etc/subuid`).

```sh
# 1. Assemble the webroot in $HOME: ~/webswr holds the site files, .env
#    (TUNNEL_TOKEN, chmod 600) and config.webswr; ~/webswr/Trimor is the git
#    checkout. The main README covers config.webswr and the tunnel token.
mkdir -p ~/webswr && cd ~/webswr
git clone https://github.com/jordanp123/Trimor.git
cp Trimor/config.webswr.example config.webswr   # edit if you want non-stock values
printf 'TUNNEL_TOKEN=...\n' > .env && chmod 600 .env

# 2. Install the units
mkdir -p ~/.config/containers/systemd
cp Trimor/contrib/podman/*.build Trimor/contrib/podman/*.container \
   Trimor/contrib/podman/*.network ~/.config/containers/systemd/

# 3. Keep user services running when you are not logged in (as root, once)
sudo loginctl enable-linger "$USER"

# 4. Fetch data, build and start
bash Trimor/contrib/podman/update.sh

# 5. Schedule the daily refresh (see "Daily refresh" below), then check
systemctl --user status webswr.service
journalctl --user -u webswr-tunnel.service -n 30
```

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
sudo -u webswr chmod 600 /home/webswr/webswr/.env
```

**3. As the new user, install the units and start the stack.** Docker keeps
serving throughout; traffic simply splits between the two connectors.

```sh
sudo -iu webswr
mkdir -p ~/.config/containers/systemd
cp ~/webswr/Trimor/contrib/podman/*.build \
   ~/webswr/Trimor/contrib/podman/*.container \
   ~/webswr/Trimor/contrib/podman/*.network ~/.config/containers/systemd/
bash ~/webswr/Trimor/contrib/podman/update.sh
journalctl --user -u webswr-tunnel.service -n 30   # expect a second connector to register
```

**4. Prove the Podman side is really serving** by stopping Docker briefly:

```sh
cd /root/webswr && sudo docker compose stop
curl -sI https://your.domain/webswr/ | head -1
```

Anything wrong? `sudo docker compose start` restores in seconds.

**5. Move the schedule off root cron.** Remove the root crontab line, then as
the `webswr` user set up the timer (see below).

**6. After a few clean days**, retire Docker: `sudo docker compose down` in
`/root/webswr`, then remove the old webroot and (if nothing else uses it)
Docker itself.

**Rollback** at any point before step 6: `systemctl --user stop webswr.service
webswr-tunnel.service`, then `docker compose up -d` in `/root/webswr`. The
original webroot, `.env` and root cron line are all still intact — that's why
step 2 copies rather than moves.

Two side effects worth knowing: rootless `podman system prune` only touches
that user's own image store, so this stack **stops sweeping other stacks'**
stopped containers the way the host-wide `docker system prune -a` did; and
`%h` in the units resolves to `/home/webswr`, so the stock layout needs no edits.

## Daily refresh

`update.sh` in this directory is the rootless counterpart of the repo-root one:
same self-locating webroot, same `config.webswr` parsing and validation, same
logging (start banner, `ABORTED` line with exit code, deployed commit + image
ids, size-rotated `update.log`), same fetch ordering and symlink-guarded
copy-back. It differs only where rootless requires it — no `setpriv`, no
`chown`, and `podman build` + `systemctl --user restart` in place of
`docker compose up -d`. It refuses to run as root.

Schedule it as a user timer (no root cron):

```sh
systemctl --user edit --force --full webswr-update.service
# [Service]
# Type=oneshot
# ExecStart=/bin/bash %h/webswr/Trimor/contrib/podman/update.sh

systemctl --user edit --force --full webswr-update.timer
# [Timer]
# OnCalendar=*-*-* 05:00:00
# Persistent=true
# [Install]
# WantedBy=timers.target

systemctl --user enable --now webswr-update.timer
```

A plain user crontab works too — `update.sh` sets `XDG_RUNTIME_DIR` itself when
cron hasn't, which is the usual reason `systemctl --user` fails from cron.

## Gotchas

- **Tunnel DNS name.** Compose resolved the site as both `website` (service
  name) and `WebSWR` (container name). `webswr.container` sets
  `NetworkAlias=website` so both keep working — make sure your tunnel's ingress
  rule points at one of them on port 8080 (e.g. `http://website:8080`).
- **Rootless `--cpus`** needs cgroups v2 CPU delegation. If the container fails
  to start citing cgroups, drop `--cpus=1` from `PodmanArgs=`; the memory and
  pids limits work regardless.
- **`AutoUpdate=registry`** on the tunnel keeps its image patched — enable it
  with `systemctl --user enable --now podman-auto-update.timer`. The site image
  is local and refreshes on each `update.sh` rebuild.
- **The `.build` unit** exists so a cold `systemctl --user start` works without
  a manual build. `update.sh` rebuilds `localhost/webswr:latest` directly each
  morning (data files change daily), which is unambiguous about what shipped.
- **SELinux** (Fedora/RHEL): these units mount no host volumes, so the usual
  `:z`/`:Z` relabeling issue does not arise.
- **Rootful Podman** works too: drop the units in `/etc/containers/systemd/`,
  use `systemctl` without `--user`, and adjust `update.sh` accordingly (it
  refuses to run as root as shipped). You keep the systemd integration but lose
  the rootless benefit that motivates this setup.

## Just want it running?

`podman compose up -d` (or `podman-compose`) will usually run the repo's
`docker-compose.yaml` unchanged. That is the quickest path; these quadlets are
the more idiomatic, systemd-native destination.
