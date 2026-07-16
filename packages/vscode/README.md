# agentproto VS Code extension

Operational views for a local agentproto daemon: sessions, permissions, cost,
and commands to spawn, prompt, interrupt, terminate, and inspect agents from
VS Code.

## Development

Run these commands from `packages/vscode`:

```bash
pnpm run build          # bundle src/extension.ts → dist/extension.js
pnpm run check-types
pnpm test
```

## Getting a VSIX

The official build lives in
[GitHub Releases](https://github.com/agentproto/ts/releases): the
`vscode-release` workflow packages a fresh `.vsix` and publishes it (tag
`vscode-v<version>-<sha>`) on every push to `main` that touches this package.
The `.vsix` is a build artifact — it's gitignored and never committed here.

Install a downloaded release from VS Code with **Extensions: Install from
VSIX...**, or:

```bash
code --install-extension agentproto-vscode-<version>.vsix
```

## Build a VSIX locally

```bash
pnpm package
```

The package command rebuilds the extension and writes a versioned artifact in
this directory:

```text
agentproto-vscode-<package.json version>.vsix
```

Verify the archive before installing or distributing it:

```bash
unzip -t agentproto-vscode-*.vsix
```

The VSIX intentionally contains only the runtime bundle (`dist`), activity-bar
asset (`media`), manifest, and Apache-2.0 license. Source files and tests stay
out of the distributable archive.
