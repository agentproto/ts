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

Every VSIX lives in [GitHub Releases](https://github.com/agentproto/ts/releases)
— it's a build artifact, gitignored and never committed here. Two tracks:

- **`vscode-dev-<sha>`** (prerelease) — built on every push to `main` that
  touches this package (`.github/workflows/vscode-release.yml`). Bleeding
  edge, one per commit.
- **`vscode-v<version>`** — built from `.github/workflows/release.yml` only
  when an actual release (a "Version Packages" PR merge) bumps this
  package's version, same cadence as every other package.

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
