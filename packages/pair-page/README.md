# @agentproto/pair-page (private)

The phone pair page for agentproto daemons (AIP-59). A phone scans the QR from
`agentproto pair offer --qr`, which opens

```
https://<daemon-fingerprint>.agentproto.cloud/pair#<offer>
```

The page pairs with the daemon through the rendezvous (end-to-end encrypted,
`@agentproto/pair-client`), stores the credential in IndexedDB, and installs a
service worker that serves the daemon's Control Center from the daemon itself,
through the tunnel.

## One static bundle, one origin per daemon

The same bundle is served identically on every `<fingerprint>.agentproto.cloud`.
There is no per-daemon server logic: isolation comes from the browser origin
(AIP-59 §5.8). Each daemon's page, credential, service worker and UI live on
their own origin, so script in one daemon's UI can't reach another pairing.

- `/pair` refuses an offer whose daemon fingerprint isn't the origin's first
  label, before any network I/O (the offer stays unspent), and links to the
  daemon's own origin.
- The IndexedDB store, in the page and in the worker, is scoped to the origin's
  daemon: other fingerprints read as absent and are never written.
- `/d/<fingerprint>` is the status page: connecting, daemon offline (retrying),
  revoked, outdated pairing, not paired, wrong address.
- `/d/<fingerprint>/…` is the service worker's scope. It proxies every request
  to the daemon over one tunnel client (§5.1, §5.3). The Control Center loads at
  `/d/<fingerprint>/apps/@agentik/session-chat/ui/`.

On a host that isn't a daemon origin (the workers.dev preview, `localhost`) the
page runs in a clearly labelled preview mode, with one shared origin.

## Layout

| Path | What |
| --- | --- |
| `src/main.ts` | Router: `/`, `/pair` → pair page; `/d/<fp>[/…]` → status page |
| `src/pages/pair.ts`, `src/pages/status.ts` | The pages (plain DOM, no framework) |
| `src/sw.ts` | The service worker (`dist/pair-sw.js`) |
| `src/lib/host.ts` | Which daemon this origin serves; the scoped credential store |
| `src/edge.ts`, `src/worker.ts` | The Cloudflare Worker: host check, routes, headers |
| `scripts/build.mjs` | esbuild → `dist/` (hashed page assets, fixed-name worker, `index.html`) |
| `scripts/preview.mjs` | Local server running the same edge handler over `dist/` |
| `wrangler.toml` | Worker config (`[assets]`, `run_worker_first`, no routes yet) |

## The Worker

`src/worker.ts` (logic in `src/edge.ts`) runs before every static asset:

- **Hosts:** `<fp>.<PAIR_DOMAIN>` with `fp` = `identityFingerprint` (32
  lowercase hex) is served. The apex, any other first label and deeper names get
  a 404. Extra hosts only through `PREVIEW_HOSTS` (comma-separated), for the
  workers.dev preview.
- **Routes:** `/`, `/pair`, `/d/*` → `index.html`; everything else is served as
  named from `dist/`.
- **Headers on every response:**
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
    `wss:` because the rendezvous URL comes from the offer and may be
    self-hosted. `ws://127.0.0.1:*` and `ws://localhost:*` (a local broker) are
    added only on preview and loopback hosts, never on a production daemon
    origin.
  - `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
    `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
    `Referrer-Policy: no-referrer`, a minimal `Permissions-Policy`,
    `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
  - `Cache-Control`: `no-cache` for `/pair-sw.js` and the document,
    `immutable` for the hashed `/assets/*`.

**The daemon UI's CSP is the daemon's.** Responses the service worker
synthesizes from the daemon (the Control Center, a single-file build with
inline scripts, and its API calls) never pass through the Worker, so they don't
get these headers. Whatever the daemon sends is what applies.

Everything the page runs is self-hosted from the bundle: no CDN, no web fonts,
no third-party script. The build checks that `index.html` has no inline script
or style and no cross-origin reference.

## Build, test, preview

```bash
pnpm --filter @agentproto/pair-page build        # → packages/pair-page/dist
pnpm --filter @agentproto/pair-page test         # host validation, headers, store scoping
pnpm --filter @agentproto/pair-page check-types  # page (DOM), worker script (WebWorker), edge

# Local: the same edge handler over dist/. http://<fingerprint>.localhost:8788/pair
# is a daemon origin (Chrome resolves *.localhost to loopback, a secure context);
# http://localhost:8788 is the shared preview.
pnpm --filter @agentproto/pair-page preview
```

## Deploy (Cloudflare)

```bash
pnpm --filter @agentproto/pair-page build
cd packages/pair-page
npx --yes wrangler@4 deploy                                   # production (no routes yet)
npx --yes wrangler@4 deploy --var PREVIEW_HOSTS:<name>.<subdomain>.workers.dev   # preview
```

The account comes from the environment (`CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN`). Going live then needs, outside this repo:

- the route `*.agentproto.cloud/*` on this Worker;
- a proxied wildcard DNS record `*` on `agentproto.cloud`;
- SSL/TLS Full (strict), with Universal SSL covering `*.agentproto.cloud`.
