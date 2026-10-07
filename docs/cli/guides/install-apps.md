# Install apps

An app bundles agents, workflows and an optional UI into one package your
daemon installs. This page is the user side: find an app, install it, keep it
up to date, remove it. To build or publish one, see
[build your own agent app](build-your-own-agent-app.md) and
[distribute an app](distribute-an-app.md).

## Find an app

The public catalog lists every published app. Three ways to browse it:

- **On the web:** [agentproto.sh/apps](https://agentproto.sh/apps), one card
  per app with its install command.
- **From the CLI:** `agentproto app catalog` lists app id, version, tier,
  whether it is installed, and whether an update is available. Add
  `--refresh` to skip the daemon's 5-minute cache. It needs a running daemon.
- **In the Store panel:** `agentproto app store` opens the daemon's
  [App Store](app-store.md) at `<daemon url>/store`, where you can install,
  update and uninstall with a click.

All three read the same catalog, served at
`https://agentproto.sh/catalog/v1/apps.json`. Its source is the public repo
[agentproto/apps](https://github.com/agentproto/apps).

## Install one

Installs from the catalog, a URL or a file go through the running daemon,
so start it first (`agentproto serve`). Then install by app id:

```bash
agentproto app install @agentik/session-chat
```

The daemon looks the id up in its catalog and installs the entry's pinned
`.agentapp` bundle. It downloads the bundle and refuses it if its digest
differs from the catalog entry's `sha256`, so what you install is exactly
what was published. A failed install leaves any previous install of the app
untouched.

The install also records which catalog the app came from, which is what lets
`app update` follow it later.

Other ways to install:

| You have | Run |
| --- | --- |
| A bundle URL | `agentproto app install https://example.com/notes-1.2.0.agentapp` |
| A bundle file | `agentproto app install ./notes-1.2.0.agentapp` |
| A git repo | `agentproto app install https://github.com/acme/notes --ref main` |
| A local folder | `agentproto app install ./my-app` |

A git install never runs the app's UI build step unless you pass
`--allow-build`, because that runs code from the repo on your machine. The
public catalog only lists compiled bundles for the same reason.

## Use it

`agentproto app list` shows every installed app and where its data lives.
An app with a UI opens from the Store panel (**Open**), or as a standalone
page with `agentproto app serve --app <appId>`. Its agents and workflows are
available to the daemon right away; see
[which tools can an app agent call](app-agent-tools.md).

## Keep it up to date

```bash
agentproto app update            # list available updates, install nothing
agentproto app update <appId>    # install the update for one app
agentproto app update --all      # install every available update
```

An entry counts as an update when its digest changed and its version is not
lower than the installed one. Updates come only from the catalog the app was
installed from, and each one is verified against its digest like a fresh
install. The app's data directory is kept across updates.

## Remove it

```bash
agentproto app uninstall <appId>
```

This removes the app from the daemon. Its data directory is kept, so a later
reinstall picks up where it left off. Delete that directory yourself
(`agentproto app list` shows it) if you want the data gone too.

## Add other catalogs

The daemon always reads the public catalog first. To add a private or team
catalog, list it in `~/.agentproto/app-catalog.json` or in the daemon
config:

```jsonc
{ "catalog": { "sources": [{ "url": "https://static.example.com/catalog.json" }] } }
```

Set `"defaultSource": false` under `catalog` to turn the public catalog off.
An unreachable source never breaks the listing: it shows up as a warning and
its last good copy is used. The format and the publishing side are in
[distribute an app](distribute-an-app.md#5-publish-a-remote-catalog).

Related pages: [App Store](app-store.md),
[`agentproto app` reference](../verbs/app.md).
