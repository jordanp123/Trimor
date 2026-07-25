#!/usr/bin/env python3
"""Keep the two deployments in lockstep.

The repo ships the same stack twice: Docker Compose (docker-compose.yaml +
update.sh) and rootless Podman (deploy/). They must stay equivalent -- a
hardening flag or UID that lands in one and not the other is exactly the class
of bug that shipped once already (the containers ran as 17001 while the deploy
script still chowned to 7001).

This asserts the equivalence mechanically: every security-relevant compose
directive has a matching quadlet directive, and both update scripts keep the
invariants that make a failed deploy safe. Pure stdlib -- no PyYAML, no ruby --
so it runs anywhere the rest of the suite does.

Deliberate, documented differences are listed in ACCEPTED_DIFFS below; anything
else is a failure.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []


def check(cond, msg):
    print(("  ok: " if cond else "  FAIL: ") + msg)
    if not cond:
        fails.append(msg)


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


# Differences that are intentional, so the test documents rather than flags them.
ACCEPTED_DIFFS = """
  - podman has no FETCH_UID/setpriv drop: rootless already runs unprivileged
    and cannot switch UIDs. It keeps the staging dir + symlink-guarded copy-back.
  - podman has no chown block: rootless maps UIDs through subuid, and image
    content arrives via COPY at build time.
  - the tunnel token is a podman secret rather than .env.
  - podman adds image rollback; compose relies on `up -d` keeping the old
    container when a build fails.
"""


# ---------------------------------------------------------------- compose ---
def compose_service(text, name):
    """Return the YAML block for one service (indentation-scoped, no PyYAML)."""
    m = re.search(r"^  %s:\n" % re.escape(name), text, re.M)
    if not m:
        return ""
    rest = text[m.end():]
    end = re.search(r"^  \S", rest, re.M)
    return rest[: end.start()] if end else rest


def quadlet(path):
    """Parse a systemd unit into a list of (key, value); duplicates preserved."""
    out = []
    for line in read(*path).splitlines():
        line = line.strip()
        if not line or line[0] in "#;[":
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            out.append((k.strip(), v.strip()))
    return out


def val(pairs, key):
    return [v for k, v in pairs if k == key]


compose = read("docker-compose.yaml")
site_c = compose_service(compose, "website")
tun_c = compose_service(compose, "cloudflare_tunnel")
site_q = quadlet(("deploy", "quadlet", "webswr-website.container"))
tun_q = quadlet(("deploy", "quadlet", "webswr-cloudflared.container"))

print("== container hardening: docker-compose.yaml vs deploy/quadlet ==")
for label, cblock, qpairs, uid_default in (
    ("website", site_c, site_q, "17001"),
    ("tunnel", tun_c, tun_q, "17000"),
):
    check("read_only: true" in cblock and val(qpairs, "ReadOnly") == ["true"],
          "%s: read-only rootfs in both" % label)
    check("- ALL" in cblock and val(qpairs, "DropCapability") == ["ALL"],
          "%s: all capabilities dropped in both" % label)
    check("no-new-privileges" in cblock and val(qpairs, "NoNewPrivileges") == ["true"],
          "%s: no-new-privileges in both" % label)
    # compose carries the UID as a ${VAR:-default}; the quadlet as a literal
    # (install.sh writes the real value at install time from config.webswr).
    m = re.search(r"user:\s*\"?\$\{[A-Z_]+:-(\d+)\}", cblock)
    check(m and m.group(1) == uid_default and val(qpairs, "User") == [uid_default]
          and val(qpairs, "Group") == [uid_default],
          "%s: same default UID/GID in both (%s)" % (label, uid_default))
    args = " ".join(val(qpairs, "PodmanArgs"))
    mem = re.search(r"memory:\s*(\S+)", cblock)
    if mem:
        check(("--memory=" + mem.group(1).lower()) in args.lower(),
              "%s: memory limit %s in both" % (label, mem.group(1)))
    pids = re.search(r"pids:\s*(\d+)", cblock)
    if pids:
        check(("--pids-limit=" + pids.group(1)) in args,
              "%s: pids limit %s in both" % (label, pids.group(1)))
    cpus = re.search(r"cpus:\s*'?([\d.]+)'?", cblock)
    if cpus:
        check(("--cpus=" + cpus.group(1)) in args,
              "%s: cpu limit %s in both" % (label, cpus.group(1)))
    shares = re.search(r"cpu_shares:\s*(\d+)", cblock)
    if shares:
        check(("--cpu-shares=" + shares.group(1)) in args,
              "%s: cpu_shares %s in both" % (label, shares.group(1)))

# tmpfs: same mount points and the same options on each
ctmp = dict(
    (p.split(":", 1)[0].rstrip("/"), p.split(":", 1)[1])
    for p in re.findall(r"^\s*- (/\S+:\S+)$", site_c, re.M)
)
qtmp = dict(
    (t.split(":", 1)[0].rstrip("/"), t.split(":", 1)[1]) for t in val(site_q, "Tmpfs")
)
check(set(ctmp) == set(qtmp), "website: same tmpfs mount points (%s)" % ", ".join(sorted(ctmp)))
for mp, opts in ctmp.items():
    check(qtmp.get(mp) == opts, "website: tmpfs %s has identical options in both" % mp)

# image + command for the tunnel (the site image is built from the Dockerfile)
img = re.search(r"image:\s*(\S+)", tun_c)
check(img and img.group(1) in val(tun_q, "Image")[0],
      "tunnel: same upstream image in both (%s)" % (img.group(1) if img else "?"))
cmd = re.search(r"command:\s*(.+)", tun_c)
check(cmd and val(tun_q, "Exec") == [cmd.group(1).strip()],
      "tunnel: same command in both (%s)" % (cmd.group(1).strip() if cmd else "?"))

print("\n== network topology ==")
back_q = quadlet(("deploy", "quadlet", "webswr-backend.network"))
egress_q = quadlet(("deploy", "quadlet", "webswr-egress.network"))
check("internal: true" in compose and val(back_q, "Internal") == ["true"],
      "backend network is internal in both")
check(val(egress_q, "Internal") == [], "egress network is not internal in either")
# The property that actually matters: nginx must have no route off the host.
check(re.search(r"networks:\n\s+- backend\n", site_c)
      and val(site_q, "Network") == ["webswr-backend.network"],
      "nginx joins ONLY the internal network in both (zero egress)")
check(sorted(val(tun_q, "Network")) == ["webswr-backend.network", "webswr-egress.network"],
      "tunnel joins both networks in both")

print("\n== deploy-script invariants: update.sh vs deploy/bin/webswr-update.sh ==")
d_sh = read("update.sh")
p_sh = read("deploy", "bin", "webswr-update.sh")
for label, needle in (
    ("aborts on any error (set -e)", r"set -eEu"),
    ("config parsed as data, never sourced", r"cfg\(\)\s*\{\s*sed -n"),
    ("logs a start banner", r"update run started"),
    ("logs ABORTED with the exit code", r"ABORTED \(exit"),
    ("records the deployed commit", r"deployed commit:"),
    ("logs an OK banner", r"=== OK "),
    ("rotates its own log", r"update\.log"),
    ("refuses a hostile SUBPATH", r"SUBPATH must be a plain path segment"),
    ("fetches into a throwaway staging dir", r"mktemp -d"),
    ("refuses symlinked fetch output", r"is missing or not a regular file"),
):
    check(re.search(needle, d_sh) and re.search(needle, p_sh),
          "both scripts: %s" % label)

# Ordering invariants -- the failsafes that make a broken deploy survivable.
for label, sh in (("docker", d_sh), ("podman", p_sh)):
    check(sh.index("fetch_data.py") < sh.index("fetch_cape.py"),
          "%s: fetch_data runs before fetch_cape (CAPE aligns to its year axis)" % label)
    prune = sh.rindex("prune -f -a")
    check(prune > sh.rindex("build --pull"),
          "%s: prune runs after the rebuild, never before" % label)
    start = sh.rindex("up -d") if "up -d" in sh else sh.rindex('restart "$TUNNEL_UNIT"')
    check(prune > start, "%s: prune runs after the containers are up" % label)

# The webroot is rebuilt from the same list, and the same fetch outputs return.
d_rm = re.search(r"rm -rf ([^\n]+)", d_sh).group(1)
p_rm = re.search(r"rm -rf ([^\n]+)", p_sh).group(1)
check(d_rm == p_rm, "both scripts wipe the same webroot paths (%s)" % d_rm)
d_out = re.search(r"for f in ([^;\n]+); do", d_sh).group(1)
p_out = re.search(r"for f in ([^;\n]+); do", p_sh).group(1)
check(d_out == p_out, "both scripts copy back the same fetch outputs")

print("\n== config surface ==")
example = read("config.webswr.example")
keys = set(re.findall(r"^([A-Z_]+)=", example, re.M))
consumers = d_sh + p_sh + read("deploy", "install.sh")
# FETCH_UID is docker-only by design (see ACCEPTED_DIFFS).
for k in sorted(keys):
    check(k in consumers, "config.webswr key %s is read by at least one script" % k)
check("FETCH_UID" in d_sh and "FETCH_UID" not in p_sh,
      "FETCH_UID is docker-only, as documented")

print("\nAccepted differences (by design):" + ACCEPTED_DIFFS)
print("DEPLOY PARITY: %s" % ("all checks passed" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)
