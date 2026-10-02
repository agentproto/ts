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

A catalog is a **static JSON file** on any HTTP host:

```json
{
  "entries": [
    {
      "appId": "weather-app",
      "name": "Weather App",
      "description": "Forecasts and alerts",
      "version": "1.2.0",
      "url": "https://static.example.com/apps/weather-app.agentapp",
      "source": { "kind": "agentapp", "url": "https://static.example.com/apps/weather-app.agentapp" }
    }
  ]
}
```

Point the daemon at it, two ways (config wins when both are set):

```jsonc
// app-catalog.json next to your apps, or
// daemon config:
{ "catalog": { "sources": [{ "url": "https://static.example.com/catalog.json" }] } }
```

`app_catalog` then merges remote entries after local ones (dedupe by
`appId`, first wins), caches them for 5 minutes, and `app_catalog
{refresh: true}` bypasses the cache. A failing source — bad JSON, timeout,
5xx — never fails the tool: it is reported in the response's `warnings[]`.

Each remote entry carries its `source`, so a store UI can call
`app_install {url, ref, subdir}` (git) or `app_install {url}` (`.agentapp`)
straight from the listing. That is the whole registry story: a static JSON
file next to static `.agentapp` files on any HTTP host, no server logic
required.

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
