# Distribute an app

Once an app runs on your daemon ([scaffold it](guides/create-agentproto-app.md),
[serve it](../verbs/app.md)), the next question is how it reaches other
machines and other people. agentproto ships three distribution primitives,
and none of them need a server beyond static file hosting:

1. **Git install** — `app_install {url, ref, subdir}` clones a repo, and
   `app_resync` keeps the install current against it.
2. **`.agentapp` bundle** — `agentproto app pack` zips the app into a single
   verified artifact; `app_install {url}` installs it from any HTTP host.
3. **Remote catalog** — a static JSON file listing apps; `app_catalog`
   merges it into the local view so a UI can offer one-click installs.

Every install records its **provenance** on the installed-app record
(`source`), which is what makes re-sync, sha verification and reproducible
updates possible.

---

## 1. Install from git: `app_install {url}` + `app_resync`

```jsonc
// via the daemon's MCP tools
app_install {
  "url": "https://github.com/acme/agentproto-apps",
  "ref": "main",            // optional branch or tag
  "subdir": "apps/weather"  // optional path inside the repo
}
```

The install clones the repo at `ref`, resolves the app in `subdir` (or the
repo root), validates its `APP.md` frontmatter, builds the UI bundle when
one is declared, and registers it. The installed record pins:

- the resolved commit (`source.sha`),
- the resolved ref (`source.ref`),
- the URL and subdir.

`app_resync {appId}` re-checks that source later: `git ls-remote` for the
installed ref against the pinned sha. Current → `{changed: false}`; moved →
reinstall and report `{changed: true, from, to}`. The app's durable data
directory (`dataDir`) is kept across a resync, so generated output and
app-scoped storage survive the update.

A failed remote re-install never wipes the previous install: the old record
stays registered and usable until the new one validates.

## 2. Install from a `.agentapp` bundle

```bash
agentproto app pack ./my-app --release --out ./my-app.agentapp
```

`--release` builds the UI first, leaves UI sources, docs, data, scripts,
logs and source maps out of the bundle, and strips `ui.build` from the
packed APP.md. Narrow the contents further with the APP.md `package` block
(`include` / `exclude` globs, see `agentproto app pack`).

Then host the `.agentapp` file anywhere static files are served, and:

```jsonc
app_install { "url": "https://static.example.com/apps/my-app.agentapp" }
```

The bundle's `sha256` is verified on download and pinned on the record
(`source.kind: "agentapp"`). Corrupted or tampered files are refused.
`app_resync` works the same way: re-download, compare hashes,
`{changed: false}` when identical.

```jsonc
// check what an install actually came from
app_status { "appRunId": "..." }        // runtime view
app_list { "full": true }               // every record incl. source
```

Apps installed from a local `dir` carry no `source`; `app_resync` on those
is a no-op that tells you to re-run `app_install`.

## 3. Declare what your app needs and exposes

Distribution works better when the consumer knows what it is accepting.
Four APP.md frontmatter keys describe the app's boundary:

```yaml
---
id: weather-app
name: Weather App
placement: box        # local | box | any | split
requires:
  browser: false      # needs the user's real browser
  fs: false           # needs the local filesystem beyond app data
  gpu: false
  secrets: [WEATHER_API_KEY]
  apps: []            # other app ids this app depends on
exposes:
  agents: [weather-assistant]
  workflows: [get-forecast]
accepts:
  tasks: true         # accept A2A tasks (§4)
---
```

- `placement` says where the app wants to run: `local` (host machine),
  `box` (a sandbox box), `any`, or `split`.
- `requires` is the capability contract a host checks before offering the
  app to a user.
- `exposes` is the A2A-visible surface — ids must exist among the app's
  declared agents/workflows.

`app_apply` validates `requires` on the same scope before the app's
capabilities become available there.

## 4. Expose the app over A2A

Every installed app that sets `exposes` and `accepts.tasks` gets two HTTP
routes on the daemon:

```
GET  /.well-known/agent-card.json                    the daemon index card
GET  /a2a/apps/:appId/.well-known/agent-card.json    one card per app
POST /a2a/apps/:appId                                A2A 1.0 JSON-RPC task ingress
```

The card is built by `@agentproto/a2a` from the app handle: name,
description, and one skill per exposed agent/workflow. `message/send`
against the ingress is mapped to an app run of the matching workflow, and
`tasks/get` reads the run's status and artifacts back. Nothing else opens —
an app that does not set `accepts.tasks` has no ingress at all.

## 5. Publish a remote catalog

The default public catalog is a static JSON file served at
`https://agentproto.sh/catalog/v1/apps.json`, which relays the
`catalog/v1/apps.json` generated in the `agentproto/apps` repo (see
[the public catalog flow](#the-public-catalog-flow) below). The
`.agentapp` bundles it references are assets of GitHub Releases on the
public `agentproto/apps` repo: one release per app version, tagged
`<slug>@<version>` (the `slug` is the last segment of the appId without its
scope: `@agentik/session-chat` -> `session-chat`), with the bundle attached
as `<slug>-<version>.agentapp`. Its asset URL is therefore
`https://github.com/agentproto/apps/releases/download/<slug>%40<version>/<slug>-<version>.agentapp`
(the `@` of the tag is encoded `%40`).

Any catalog is still just a **static JSON file** on any HTTP host, in the
`app-catalog/v1` format:

```json
{
  "schema": "app-catalog/v1",
  "generatedAt": "2026-10-02T00:00:00Z",
  "entries": [
    {
      "appId": "weather-app",
      "name": "Weather App",
      "description": "Forecasts and alerts",
      "category": "app",
      "version": "1.2.0",
      "tier": "bundle",
      "publisher": "example",
      "license": { "kind": "free" },
      "source": {
        "kind": "agentapp",
        "url": "https://static.example.com/apps/weather-app-1.2.0.agentapp",
        "sha256": "3f5a0c9e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f",
        "version": "1.2.0"
      }
    }
  ]
}
```

Only `appId` and `source` are required. A `.agentapp` source needs `url`,
`sha256` (the bundle's `manifest.json` digest, printed by
`agentproto app pack --release --json`) and `version`; a git source needs
`url` and the pinned commit `sha` (plus optional `ref` / `subdir`). The
other fields (`name`, `description`, `category`, `icon`, `version`, `tier`
-- `git` | `bundle` | `hosted`, `placement`, `publisher`, `license`,
`requires`, `minAgentprotoVersion`, `featured`) are optional metadata for a
store UI. Unknown fields are ignored; an entry that fails validation is
skipped with a warning, the rest of the catalog still loads.

### Publishing with the CLI: pack --release --entry, then catalog build

You do not have to hand-write those entries. Two CLI verbs cover the
publishing path:

```sh
# 1. Pack a release bundle AND write a catalog entry next to it:
agentproto app pack <appDir> --release --entry [--out <dir|file.agentapp>] \
  [--asset-url <url>] [--publisher <name>]
```

`--entry` (which requires `--release`) writes the bundle as
`<slug>-<version>.agentapp` and a validated `<slug>-<version>.entry.json`
catalog entry beside it: `appId`, `name`, `description`, `category`, `icon`
and `placement` come from the APP.md frontmatter, `version` must be
declared there (packing fails without it), `tier` is `bundle`, `license`
defaults to `{kind: "free"}`, and `source` carries the bundle's own
`sha256` (the exact digest `app_install {sha256}` verifies at install
time), its byte `size`, and the asset `url`: `--asset-url` if given, else
the GitHub Releases URL of the `agentproto/apps` repo described above.

```sh
# 2. Merge the entries into the published apps.json:
agentproto catalog build <entry.json|dir>... --out <apps.json> \
  [--base <apps.json>] [--check] [--emit-ts <first-party-catalog.ts>]
```

`catalog build` validates every entry file (a directory is walked
recursively for `*.json`, so it can take the `agentproto/apps` repo's
`entries/` tree directly), merges them over `--base` by `appId` (an
incoming entry replaces the existing one when its version is >=; an older
version is warned about and ignored) and writes a deterministic document:
entries sorted by `appId`, 2-space indent, trailing newline. Without
`--base`, the result contains exactly the given entries, so a deleted
`entries/<appId>.json` makes the app disappear from the catalog; the same
`appId` twice among the inputs is an error. `generatedAt` is kept
from `--base` when nothing changed, so a no-op build produces no diff.
`--check` writes nothing and exits 1 when `--out` is out of date
(ignoring `generatedAt`), the CI drift guard. `--emit-ts` also
renders the daemon's embedded first-party fallback
(`packages/runtime/src/first-party-catalog.ts`); the same file is
regenerated from the live published catalog by
`pnpm --filter @agentproto/runtime catalog:first-party`, which the
`catalog-sync.yml` workflow runs before opening its sync PR.

### The public catalog flow

The public catalog's SOURCE is the `agentproto/apps` repo, not a hand-held
JSON blob:

- `entries/<appId>.json` holds one `AppCatalogEntry` per app (the file an
  `app pack --release --entry` writes, committed under its appId).
- The repo's CI regenerates `catalog/v1/apps.json` with
  `agentproto catalog build entries --out catalog/v1/apps.json --check`.
- The site serves that generated file at
  `https://agentproto.sh/catalog/v1/apps.json` (the URL
  `DEFAULT_CATALOG_SOURCE_URL` points at), by relaying it. Bundles are
  still GitHub Release assets: first-party ones on `agentproto/apps`,
  third-party ones wherever the publisher hosts them.

To publish a third-party app:

1. Host the `.agentapp` somewhere https-reachable (e.g. a GitHub Release
   on your own repo).
2. `agentproto app pack <appDir> --release --entry --asset-url <url>`:
   the entry's `source.url` points at your hosting.
3. Check it locally before anyone else sees it:
   `agentproto catalog verify <entry.json>` (add
   `--offline-file <appId>=<local>.agentapp` to skip the download). This
   downloads/substitutes the bundle, checks size and digest, unpacks it,
   and confirms the APP.md matches and passes `app validate`.
4. Open a PR on `agentproto/apps` adding `entries/<appId>.json`. Ids under
   the `@agentproto/*` scope are reserved for the maintainers (that rule
   is enforced by the repo's CI, which knows the PR author, not by the
   CLI).

`app_catalog` always queries the **default public catalog** first, then
the sources you add. Add yours in either place (config wins over the
catalog file when both list sources; both ADD to the default one):

```jsonc
// ~/.agentproto/app-catalog.json:
{ "apps": [], "sources": [{ "url": "https://static.example.com/catalog.json" }] }
// or daemon config:
{ "catalog": { "sources": [{ "url": "https://static.example.com/catalog.json" }] } }
// turn the default catalog off, or point it elsewhere:
{ "catalog": { "defaultSource": false } }
```

`app_catalog` merges remote entries after local ones (dedupe by `appId`,
first wins — the default catalog before yours), caches each source for 5
minutes in memory and keeps its last good copy under
`~/.agentproto/cache/catalog/`, and `app_catalog {refresh: true}` bypasses
the in-memory cache. A failing source — bad JSON, timeout, 5xx — never
fails the tool: it is reported in the response's `warnings[]` and its
cached copy is served with `stale: true`. When the default catalog has
never been reachable, a small first-party list embedded in the daemon
stands in for it (`origin: "embedded"`).

Each remote entry carries its `source`, so a store UI can call
`app_install {url, ref, subdir, sha}` (git) or `app_install {url, sha256}`
(`.agentapp`) straight from the listing — passing the entry's digest makes
the install refuse anything that doesn't match it. That is the whole
registry story: a static JSON file next to static `.agentapp` files on any
HTTP host, no server logic required.

### Updates

Pass the entry's `catalogUrl` when installing from a listing —
`app_install {url, sha256, catalogUrl}` — and the record keeps
`source.catalogId`. From then on:

- `app_updates` compares each catalog-tracked app with its catalog's current
  entry (without installing anything): an entry is an update when its digest
  / commit differs and its version is not lower than the installed one.
- `app_resync {appId}` installs that entry — from the entry's own URL,
  verified against its digest — so a new release published under a new,
  versioned URL (`my-app-0.3.0.agentapp`) is picked up. Only the catalog the
  app was installed from is followed, never another source listing the same
  `appId`.
- `app_catalog` marks such an entry `updateAvailable: true`.

---

## The full loop

```bash
# author & publish (once)
agentproto app pack ./my-app --release --out ./my-app.agentapp
# host my-app.agentapp + catalog.json on any static host

# consume (anywhere)
app_install { "url": "https://static.example.com/apps/my-app.agentapp" }
app_catalog { "refresh": true }          # see the remote listing
app_resync { "appId": "my-app" }         # later: pick up the new bundle
```

Related pages: [app verb reference](../verbs/app.md),
[scaffold an app](create-agentproto-app.md),
[app agent tools](app-agent-tools.md).
