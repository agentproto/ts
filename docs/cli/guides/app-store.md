# App Store

The daemon ships a builtin **App Store panel** at `/store`: a point-and-click
surface over the same verbs the MCP tools expose, so installing an app
([distribute an app](distribute-an-app.md)) never requires a CLI session.

```bash
agentproto serve   # then open http://127.0.0.1:<port>/store in a browser
```

`/store` redirects to the panel's standalone UI
(`/apps/@agentproto/store/ui`). The panel is a daemon builtin, like the
sessions panel: nothing to install, and it always shows up under
`app_catalog` (category `builtin`).

## What the shelf shows

- **Installed**: version, install source (local, git or `.agentapp`), and an
  `Update available` badge when `app_updates` reports one. Actions: **Open**
  (when the app has a UI), **Update** (`app_resync`), **Uninstall**
  (`app_uninstall`, with a confirmation).
- **Featured** and **Available**: uninstalled catalog entries grouped by
  category, with tier / placement / requires chips and an **Install** button
  that pins the entry's own sha (`sha256` for a bundle, `sha` for git).
- **Install from URL**: paste a `.agentapp` URL or a git repo URL; git
  entries take an optional ref and subdir.
- **Sources**: warnings from unreachable catalog sources and offline state.
- **Builtin panels**: the daemon's own panels, collapsed.

## Install confirmation

Installing from the panel is always an explicit two-step confirmation: the
first call answers a preview (URL, the pinned sha, and whether a build
command would run) and installs nothing; the install only happens once you
confirm in the dialog. Direct MCP and CLI calls keep the single-call
behaviour; the confirmation applies only to installs driven from an app UI.

## Deep link

Open the store with `?install=<appId>` to pre-select and scroll to an entry
and open its install confirmation, so other pages (the empty states of the
apps tree, S7) can send a user straight to the shelf.

Related pages: [distribute an app](distribute-an-app.md),
[app verb reference](../verbs/app.md).
