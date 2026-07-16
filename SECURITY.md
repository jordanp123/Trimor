# Security

WebSWR is built to be safe even when a user is **actively hostile** — trying to
inject code, crash the page, or exhaust the browser. This document describes the
threat model, the properties that make the design safe, and the specific
mitigations in the code.

## Threat model

WebSWR is a **static, client-side application**. There is no backend, no
database, no authentication, and it makes **no network requests at runtime**.
That removes most of the usual web attack surface outright:

- No server-side code → no SQL injection, no RCE, no auth bypass, no SSRF.
- No network calls → nothing to intercept, no API to abuse, no data exfiltration.
- No accounts or cookies → no session/CSRF issues.

The realistic attacker is therefore someone who crafts a **malicious share link**
and gets a victim to open it, hoping to (a) run script in the victim’s browser
(XSS) or (b) hang/crash the victim’s browser (client-side DoS). The only
attacker-controlled input channel is the **URL hash** (the “Copy link” state).
Everything else is the user’s own typed input.

## What makes it safe

**No dynamic code execution, no HTML injection.**
There is no `eval`, no `new Function`, no `setTimeout`/`setInterval` with string
arguments, and no `innerHTML` / `outerHTML` / `insertAdjacentHTML` /
`document.write` anywhere in the runtime code. All DOM is constructed with
`createElement` and `textContent`; the only HTML in the document is the static
shell and Help text, which contain no user data. (Verified by grep; a regression
would show up immediately.)

**Strict Content-Security-Policy** (in `index.html`, and recommended as a header
too — see Deployment):

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'none'; worker-src 'self'; object-src 'none';
child-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';
```

- `script-src 'self'` with **no `'unsafe-inline'`/`'unsafe-eval'`** — even if an
  injection were found, the browser would refuse to run inline or eval’d script.
- `connect-src 'none'` — the page cannot make `fetch`/XHR/WebSocket calls at all.
- `frame-ancestors 'none'` — cannot be framed (clickjacking).
- `base-uri 'none'`, `form-action 'none'`, `object-src 'none'` — close common
  bypasses.

**Zero runtime dependencies.** There is no `node_modules`, no bundler, no CDN,
no web fonts — nothing in the supply chain to be compromised. The only scripts
are first-party and same-origin, so Subresource Integrity is unnecessary. The
Web Worker loads its modules with `importScripts` of same-origin files only.

**Untrusted input (the URL hash) is parsed defensively.**
`atob` → `decodeURIComponent` → `JSON.parse` all run inside a `try/catch`; a
malformed hash is silently ignored. The parsed object is consumed against a
**whitelist** of known input ids; values are written only to form fields
(`input.value`, which never executes) and coerced to numbers for the engine.
There is **no recursive merge** of the parsed object into anything, so
`__proto__`/`constructor` payloads cannot pollute prototypes.

**Unknown enum values degrade safely.** A hash that sets an unexpected strategy,
Monte-Carlo method, or inflation mode falls through to a safe default rather than
erroring (the engine’s `switch` has a `default`, and Monte Carlo validates the
method against an allow-list).

## Denial-of-service bounds

Because everything is client-side, a “DoS” can only target the visitor’s own
browser — but a hostile link could still try to hang or OOM it. Every value
derived from untrusted input is bounded **before** it can size a loop or an
allocation:

| Vector | Bound | Where |
|---|---|---|
| Income / adjustment rows | ≤ **50** each | `applyState` slices the arrays |
| Retirement length (N) | ≤ dataset length (155) | `validate()` + clamp in `buildParams` |
| Starting portfolio | finite, ≤ $10T | `validate()` (rejects `Infinity`) |
| Monte Carlo trials | ≤ **50,000** | `clampTrials` **and** a hard cap inside `mc.run` |
| Bisection solver | fixed 28 iterations | `solveSpending` |

The caps are applied in **two independent layers** (the UI and the engine), so
the compute core stays safe even if it’s ever called directly. Worst-case Monte
Carlo memory (50,000 trials × 155 years) is bounded to roughly ~125 MB held
transiently inside the isolated Worker, which cannot take down the page.

These bounds are exercised by an automated test: `tests/security_test.js` loads
the whole app with a hostile hash (100,000 income rows, `years: 1e9`,
`initialValue: 1e400`, `trials: 1e9`) and asserts the app neither hangs nor
renders bogus results. Run it with `sh tests/run.sh`.

## Privacy

- No telemetry, analytics, cookies, or fingerprinting.
- The only browser storage used is `localStorage["swr-theme"]` (light/dark).
- “Copy link” encodes your scenario into the URL hash so you can bookmark/share
  it. **That link contains your financial inputs** — share it deliberately. The
  hash is never sent anywhere by the app (there is no network code); it only
  matters if *you* paste the link somewhere.
- `<meta name="referrer" content="no-referrer">` avoids leaking the URL via the
  Referer header on any navigation.

## Out of scope

- **Hosting.** The security of the static host/CDN that serves the files
  (TLS config, access control, integrity of the deployed bytes) is the operator’s
  responsibility. See Deployment.
- **The data pipeline** (`tools/fetch_data.py`, `tools/fetch_cape.py`) never
  runs in the browser app — it runs on the host (the developer’s machine or a
  server-side cron) before the image is built. It fetches only pinned public
  sources over certificate-verified HTTPS with redirects refused and response
  sizes capped, validates the parsed numbers against independent anchors,
  writes atomically, and exits non-zero on any doubt — so a failed fetch skips
  the rebuild and the site keeps serving the last-known-good data.

## Deployment hardening (recommended)

Deployment settings live in `config.webswr` (server-local, gitignored — see
`config.webswr.example`). It holds **no secrets**: paths, container UIDs/names
and the URL path only. The single secret, the Cloudflare `TUNNEL_TOKEN`, stays
in `.env` (root-owned, `chmod 600`), which the update script re-asserts on
every run.

The app is safe opened directly, but when hosting it, also send these as **HTTP
response headers** (a header CSP is stronger than the `<meta>` fallback, and
`frame-ancestors` — the clickjacking protection — only works as a header).
`nginx.conf` sets all of them at the origin, plus `Cache-Control:
no-cache` (filenames aren't content-hashed and the CAPE data changes daily, so
nothing may be cached as immutable):

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'nonce-<per-request>'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
```

The `nonce` is generated fresh per response (`$request_id` in nginx.conf; HTML
is `no-cache`, so nonces are never reused). The app ships no inline scripts of
its own — the nonce exists so an edge proxy's injected script (e.g. Cloudflare
bot detection, which stamps the response's nonce onto its injection) can run
without resorting to `unsafe-inline`. The `<meta>` CSP fallback in index.html
carries `unsafe-inline` instead (a `<meta>` policy cannot express per-request
nonces), but it only governs deployments with **no** CSP header — when the
header is present, browsers enforce the intersection of both policies and the
strict nonce rule wins.

Serve over HTTPS, and prefer an immutable/static host. No server-side runtime is
required or recommended.

## Reporting

This is an educational project. If you find a security issue, please open an
issue describing it (or contact the maintainer privately for anything sensitive)
rather than sharing a working exploit publicly.
