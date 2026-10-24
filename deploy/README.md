# WebSWR — rootless Podman deployment

Everything needed to run WebSWR under **rootless Podman** with systemd
[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
units: containers become real user services with boot ordering,
restart-on-failure, journald logs and a daily auto-update timer. `install.sh`
does the wiring.

The repo root also ships an equivalent Docker Compose deployment
(`docker-compose.yaml` + `update.sh`). **This directory is the Podman path** —
you want one or the other, not both running at once.

**Changing either deployment?** Change both. `tests/deploy_parity.py` compares
them on every run of the test suite and fails if they drift.

**Why rootless:** the container hardening is identical either way (read-only
rootfs, all capabilities dropped, no-new-privileges, non-root user,
internal-only network for nginx). The gain is that no root-owned daemon is in
the path and **the daily update job stops running as root** — so a compromise of
your git remote or the data pipeline lands as one unprivileged user instead of
root. This stack is an easy rootless fit because it **publishes no ports** (the
tunnel dials out), so there is no bind-below-1024 problem.

Requires **Podman 5+** and cgroups v2. Subuid sizing matters here — see below.

### User namespaces and `/etc/subuid`

Both containers carry `UserNS=auto:size=65536`, so Podman gives **each one its
own private, non-overlapping range of host UIDs**. A process escaping one
container therefore lands in a namespace that doesn't overlap the other
container's — or any other stack's on the same host.

That costs subuids: **containers × size**, i.e. `2 × 65536 = 131072` for this
stack — *twice* the 65536 a distro typically allocates. Check what the deploy
account has:

```sh
grep "^$USER:" /etc/subuid /etc/subgid
```

If it is short, the containers simply fail to start. Widen the range in both
files, then:

```sh
podman system migrate                 # re-map existing containers to the new range
systemctl --user daemon-reload
systemctl --user restart webswr-website.service webswr-cloudflared.service
```

Two related constraints: `APP_UID`/`TUNNEL_UID` in `config.webswr` must be
**below** `size=` (a UID with nowhere to land inside the mapping cannot start —
`install.sh` refuses the install rather than let it fail at 05:00), and if the
host runs several rootless stacks, **each account needs its own non-overlapping
range** (`cat /etc/subuid` to confirm).

> **Status: this is what the project's own server runs.** The Docker Compose
> deployment is maintained alongside it and the two are held in lockstep by
> `tests/deploy_parity.py` (part of `sh tests/run.sh`), which fails the suite if
> a hardening flag, UID, limit, network rule or deploy-script invariant lands in
> one and not the other.

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
lingering, list the key(s) allowed to deploy (see [Signed commits](#signed-commits-the-deploy-gate)
— the updater refuses to run without that list), run the updater once (it
assembles the webroot, fetches data, builds and starts everything), and enable
the timer.

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
# the trust list: see "Signed commits" below
mkdir -p ~/.config/webswr && chmod 700 ~/.config/webswr
printf '%s\n' 'you@example.com namespaces="git" ssh-ed25519 AAAA...' > ~/.config/webswr/allowed_signers
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
fails to come up. It refuses to run as root. Like `update.sh`, it deploys only
commits signed by a key you have listed — see the next section.

```sh
systemctl --user start webswr-update.service      # run it now
journalctl --user -u webswr-update -f             # watch
systemctl --user list-timers webswr-update.timer  # when is it next due?
```

Run it directly with `WEBSWR_BASE=/path/to/webroot ~/.local/bin/webswr-update.sh`
if your webroot is not `~/webswr` (the timer needs nothing extra — the unit
carries the path).

## Signed commits (the deploy gate)

The nightly job deploys whatever is on the repo's branch, so without a check a
stolen GitHub login would reach every visitor by the next morning. Both update
scripts therefore refuse to deploy a commit unless it is **signed by a key you
listed on the server**. Someone holding your GitHub account can push code, but
they cannot produce that signature: the private key never leaves the machine
you commit from.

On every run, before anything else is touched:

- The trust list is `~/.config/webswr/allowed_signers` for the account the job
  runs as (`/root/.config/webswr/allowed_signers` for the Docker `update.sh`).
  It lives outside the webroot and the checkout, so no commit — signed or not —
  can edit it, and the script refuses one that another user could write.
- **Every** commit between the deployed one and the new tip must verify, not
  just the tip. A foreign commit stays refused even after a signed one lands on
  top of it — say, after you pulled it down without noticing.
- A first clone is verified at its tip before it becomes the checkout.
- A rewritten history (a force-push) is refused outright.
- On any refusal the run aborts, `update.log` names the commit and the reason
  (`is not signed`, `is signed by a key that is not in …`), and the site keeps
  serving the last build that passed. A run with nothing new to deploy still
  refreshes the market data and rebuilds as usual.

**One-time setup on the machine you commit from.** A dedicated SSH key just for
signing (a passphrase is optional; with one, git asks for it on each commit):

```sh
ssh-keygen -t ed25519 -C "WebSWR commit signing" -f ~/.ssh/webswr_signing
cd /path/to/your/checkout
git config gpg.format ssh
git config user.signingkey ~/.ssh/webswr_signing
git config commit.gpgsign true
```

Optionally, let git check your own signatures locally too:

```sh
printf 'you@example.com namespaces="git" %s\n' "$(cat ~/.ssh/webswr_signing.pub)" > ~/.ssh/allowed_signers
git config gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
git log --show-signature -1
```

**On the server**, as the deploy user, put the same line in the trust list.
The key part is the contents of `webswr_signing.pub`; the email is only a label:

```sh
mkdir -p ~/.config/webswr && chmod 700 ~/.config/webswr
printf '%s\n' 'you@example.com namespaces="git" ssh-ed25519 AAAA...' > ~/.config/webswr/allowed_signers
chmod 644 ~/.config/webswr/allowed_signers
```

Deploying a repo someone else signs? List their public key instead of, or as
well as, yours: one line per key.

**Turning it on for an existing deployment.** In this order, so nothing is
refused by surprise:

1. Set up signing as above, and make sure your next commit is signed
   (`git log --show-signature -1`).
2. Push it. The update script already installed on the server has no gate yet,
   so the nightly run deploys it as usual.
3. On the server, create the trust list, then re-run `./deploy/install.sh` from
   the updated checkout to install the new update script.
4. Run the updater once by hand and look for a `signed-commit gate:` line in
   `update.log`.

**Deploying a commit you didn't sign on purpose** (a GitHub web edit, a merged
pull request): inspect it, then move the checkout past it by hand. Later runs
only verify commits after that point.

```sh
cd ~/webswr/Trimor && git fetch && git log -p HEAD..@{u}   # read what you are accepting
git merge --ff-only <commit>
```

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

## Verifying the isolation actually holds

The architecture's central claim is that **nginx has no route off the host** —
it can answer the tunnel and nothing else. That is worth proving rather than
assuming, especially after a migration (the rootless network stack is netavark,
not Docker's bridge, so an earlier check doesn't carry over):

A bare "did it fail?" check is not enough: a probe that never ran produces the
same non-zero exit as a blocked one. So this runs a **positive control first**
(the container's own port, which must succeed) and reports elapsed seconds for
both. It also targets a raw IP rather than a URL — that keeps DNS failure from
masquerading as a routing failure, and leaves nothing for a terminal to mangle
into a markdown link.

```sh
podman exec WebSWR sh -c 'S=$(date +%s); nc -z -w3 127.0.0.1 8080; A=$?; M=$(date +%s); nc -z -w3 1.1.1.1 443; B=$?; E=$(date +%s); echo "own-port(control): exit=$A in $((M-S))s | internet: exit=$B in $((E-M))s"' 2>&1

# ...while the site itself keeps serving through the tunnel:
curl -sI https://your.domain/webswr/ | head -1
```

Reading the result:

| own-port (control) | internet | verdict |
| --- | --- | --- |
| `exit=0` | `exit=1` in 0s | **Pass, strongest form** — no route exists, so the kernel refused immediately (`ENETUNREACH`) and no packet was sent |
| `exit=0` | `exit=1` in ~3s | **Pass** — packets were emitted and silently dropped downstream |
| `exit=1` | anything | **Void** — `nc` is missing or `-z` unsupported here; the probe never ran, so the second column means nothing |
| anything | `exit=0` | **Fail** — nginx has a route off the host |

For proof by configuration rather than by probe, `podman exec WebSWR ip route`
should show **no `default` line** at all.

Worth re-running whenever Podman, the host kernel, or the network config
changes. A few more one-liners for the same reason:

```sh
podman inspect WebSWR --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}'
podman top WebSWR huser user            # host UID vs in-container UID (UserNS mapping)
podman secret ls                        # the token exists and is dated
systemctl --user list-timers webswr-update.timer
```

**Host hygiene** for a machine running several service accounts: keep the deploy
account's home unreadable by its siblings (`chmod 750 /home/webswr`), and note
that `update.log` is written owner-only (0600) for the same reason.

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
