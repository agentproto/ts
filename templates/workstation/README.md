# agentproto-workstation e2b template

Declarative build for the pre-baked e2b template `@agentproto/sandbox-e2b`
boots by default. Everything it bakes is pinned in
[`versions.json`](./versions.json) — the single source of truth:

- `cli` — the `@agentproto/cli` version
- `adapters` — the agentproto adapter packages (with their pins)
- `runtime` — agent runtime CLIs (`opencode-ai`)
- `templates.stable` / `templates.dev` — published e2b template id + alias
- `baseImage` — the image the Dockerfile builds `FROM`

Derived files (the generated TS module, marked doc blocks, and
`e2b.template.toml`'s build args) are regenerated with:

```sh
node scripts/sync-templates.mjs          # write
node scripts/sync-templates.mjs --check  # CI gate — non-zero on drift
node scripts/sync-templates.mjs --dry-run
```

## Build

Requires the [e2b CLI](https://e2b.dev/docs/cli) (`npm i -g e2b@latest`) and
`e2b auth login` (or `E2B_ACCESS_TOKEN`) on the building machine. **No build
runs from this repo's CI — publishing is a deliberate, credentialed act.**

```sh
cd templates/workstation
e2b template build
```

The template alias (`agentproto-workstation`) comes from
`e2b.template.toml`; the version pins ride in as build args declared there.
When `versions.json` changes, re-run `node scripts/sync-templates.mjs` first
so the toml's `[build.args]` match the new pins.

### Dev variant

Build the same Dockerfile against unreleased pins under the `-dev` alias:

```sh
e2b template build --template-id agentproto-workstation-dev \
  --build-arg AGENTPROTO_CLI_VERSION=<dev-pin> \
  --build-arg AGENTPROTO_ADAPTERS="@agentproto/adapter-opencode@<dev-pin> ..." \
  --build-arg OPENCODE_RUNTIME_VERSION=<dev-pin>
```

## Publish / release

`e2b template build` publishes a new template **version** under the same
template id — existing sandboxes are untouched, new boots get the new
version. The build prints the new `template_id` + version alias; if the
opaque id changed (first publish of an alias), record it in
`versions.json` (`templates.stable.id`) and re-run the sync script.

## Rollback

e2b keeps previous template versions alive:

```sh
e2b template list                       # find versions of agentproto-workstation
e2b template alias agentproto-workstation <previous-version-alias>
```

Last-resort (bad publish fully broken): point `versions.json`'s
`templates.stable.id` at the previous known-good id, re-run the sync
script, and rely on `@agentproto/sandbox-e2b`'s `updateCliOnBoot` /
`cliVersion` config as the runtime escape hatch while a fix bakes.

## Credentials needed at build time

- `E2B_ACCESS_TOKEN` (or `e2b auth login`) — template build/publish only.
- None of the agent credentials (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
  …) are baked into the image — they are injected per-boot as sandbox env
  by `@agentproto/sandbox-e2b` (`SandboxBootOpts.env`).

## Smoke checks baked into the Dockerfile

The build fails (not the first live agent turn) if any of these fail:

1. `agentproto --version` equals the `cli` pin.
2. `agentproto adapters list --json` parses and every baked adapter is
   globally installed.
3. `agentproto serve` answers `/health` on the provider's default port
   (18790).
