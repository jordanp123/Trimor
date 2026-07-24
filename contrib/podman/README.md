# Running WebSWR under Podman (rootless quadlets)

An alternative to `docker-compose.yaml` for Podman users. These are
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

> **Status: contributed, not battle-tested.** The maintained deployment is the
> Docker one. These files mirror it directive-for-directive and are reviewed by
> inspection, but they have not been through the project's usual end-to-end
> verification. Please open an issue if something needs adjusting.

## Files

| File | Compose equivalent |
| --- | --- |
| `webswr.build` | `build:` + `args:` (Podman 5.0+ only) |
| `webswr.container` | the `website` service |
| `webswr-tunnel.container` | the `cloudflare_tunnel` service |
| `webswr-backend.network` | `networks: backend: {internal: true}` |
| `webswr-egress.network` | `networks: egress` |

Values are the stock defaults. If you edited `config.webswr`, mirror the
matching values here (`STACK_NAME` → `ContainerName=`, `APP_UID`/`TUNNEL_UID` →
`User=`/`Group=`, `SUBPATH` → the `BuildArg=`). Quadlet files are systemd
units, so they do **not** expand `${VAR}` the way compose does — the values are
literal.

## Setup (rootless)

Prerequisites: Podman 4.4+ (5.0+ for `.build`), cgroups v2, and a subuid range
covering your `APP_UID` (the default 65536-wide range in `/etc/subuid` covers
the stock 17001 fine — check with `grep "^$USER:" /etc/subuid`).

```sh
# 1. Assemble the webroot exactly as the Docker deployment does, but in $HOME:
#    ~/webswr holds the site files, .env (TUNNEL_TOKEN, chmod 600) and
#    config.webswr; ~/webswr/Trimor is the git checkout. See the main README.

# 2. Install the units
mkdir -p ~/.config/containers/systemd
cp ~/webswr/Trimor/contrib/podman/* ~/.config/containers/systemd/

# 3. Keep user services running when you are not logged in
loginctl enable-linger "$USER"

# 4. Generate and start
systemctl --user daemon-reload
systemctl --user start webswr.service webswr-tunnel.service

# 5. Check
systemctl --user status webswr.service
journalctl --user -u webswr.service -f
```

On Podman older than 5.0, delete `webswr.build`, set
`Image=localhost/webswr:latest` in `webswr.container`, and build once by hand:

```sh
podman build --build-arg SUBPATH=webswr -t localhost/webswr:latest ~/webswr
```

## Daily refresh

`update.sh` in the repo root drives the Docker deployment. Under Podman,
replace its `docker compose …` block with the equivalent — everything above it
(git pull, webroot assembly, data fetch) is unchanged:

```sh
podman pull docker.io/cloudflare/cloudflared:latest
podman build --pull --build-arg SUBPATH="$SUBPATH" -t localhost/webswr:latest "$BASE"
systemctl --user daemon-reload
systemctl --user restart webswr.service webswr-tunnel.service
podman system prune -f -a
```

For the daily job prefer this explicit build with `Image=localhost/webswr:latest`
over the `.build` unit — it mirrors the Docker flow exactly and makes "the image
was rebuilt this morning" unambiguous.

Two further simplifications when running rootless: drop the `setpriv` privilege
drop around the fetchers (the whole script is already unprivileged, and an
unprivileged user cannot switch UIDs anyway), and drop the `chown` lines (the
site files enter the image via `COPY` as root at build time, and rootless maps
UIDs through subuid regardless).

Schedule it with a user timer rather than root cron:

```sh
systemd-run --user --on-calendar='*-*-* 05:00:00' --unit=webswr-update \
  /bin/bash "$HOME/webswr/Trimor/update.sh"
```

…or a user crontab (`crontab -e` as that user, no `sudo`).

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
  is local, so it refreshes on your own rebuilds.
- **SELinux** (Fedora/RHEL): these units mount no host volumes, so the usual
  `:z`/`:Z` relabeling issue does not arise.
- **Rootful Podman** works too: drop the files in `/etc/containers/systemd/`
  and use `systemctl` without `--user` (`%h` then resolves to `/root`, matching
  the stock `/root/webswr` layout). You keep the systemd integration but lose
  the rootless benefit that motivates this setup.

## Just want it running?

`podman compose up -d` (or `podman-compose`) will usually run the repo's
`docker-compose.yaml` unchanged. That is the quickest path; these quadlets are
the more idiomatic, systemd-native destination.
