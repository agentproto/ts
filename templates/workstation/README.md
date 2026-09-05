# agentproto-workstation e2b template

Declarative build for the pre-baked e2b template `@agentproto/sandbox-e2b`
boots by default. Everything it bakes is pinned in
[`versions.json`](./versions.json) — the single source of truth:

- `cli` — the `@agentproto/cli` version
- `adapters` — the agentproto adapter packages (with their pins)
- `runtime` — agent runtime CLIs (`opencode-ai`)
- `resources` — sandbox `cpuCount` / `memoryMb` the template is created with.
  These are passed as `e2b template create` **flags** (`--cpu-count` /
  `--memory-mb`), NOT read from any toml — see [Build](#build). The e2b default
  is 512 MB, which OOMs a heavy adapter install (mastra); we bake 2048 MB / 2 vCPU.
- `templates.stable` / `templates.dev` — published e2b template id + alias,
  plus the `baked` block recording what the published image was PROVEN to
  contain (`cli`, `adapters`, `builtAt`; all null = unproven bake)
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
e2b template create agentproto-workstation --cpu-count 2 --memory-mb 2048 -d Dockerfile
```

**The `--cpu-count` / `--memory-mb` flags are required, not optional.** `e2b
template create -d Dockerfile` builds the Dockerfile directly and does **not**
read `e2b.template.toml` (the e2b CLI's own config file is `e2b.toml`; ours is a
record only), so the `cpu_count` / `memory_mb` keys recorded there are ignored
at build time — resources come only from the flags. The e2b default is **512 MB**,
which OOMs the mastra adapter's runtime install and wedges the box; 2048 MB / 2
vCPU (the `resources` block in `versions.json`) is what the generator threads
into every documented build command. Keep the flag values in sync with
`versions.json` — re-run `node scripts/sync-templates.mjs` and copy the command
it records into `e2b.template.toml`.

The e2b CLI has **no `--build-arg`** (`e2b template build` is deprecated in
favour of `e2b template create`), so the pins are baked into the Dockerfile's
`ARG` defaults by `scripts/sync-templates.mjs` — one ARG per package, never a
space-separated list (E2B rewrites each `ARG` into an `ENV` and mangles spaces
in ENV values). When `versions.json` changes, re-run
`node scripts/sync-templates.mjs` first so the generated `Dockerfile` (and the
`e2b.template.toml` pin record) match the new pins.

### Dev variant

The dev channel is the **same generated Dockerfile** published under the
`-dev` alias (the pins differ only when `versions.json` declares different
ones):

```sh
e2b template create agentproto-workstation-dev --cpu-count 2 --memory-mb 2048 -d Dockerfile
```

## Publish / release

`e2b template create <alias>` publishes a new template **version** under the
same template id — existing sandboxes are untouched, new boots get the new
version. For the pinned stable channel, record the result back into
`versions.json` and re-run the sync script:

1. Set `templates.<channel>.id` to the built template id (if it changed).
2. Fill in the `templates.<channel>.baked` block with what the image was
   PROVEN to contain — `cli`, `adapters`, `builtAt` (verify inside the
   image, e.g. `e2b sandbox` + `agentproto --version` /
   `npm ls -g --depth=0`). A `null` baked field means *unknown*: consumers
   (`@agentproto/sandbox-e2b`) treat an unproven bake as stale and keep the
   on-boot `npm i -g` enabled — so an out-of-band or unverified bake never
   silently boots the wrong CLI or loses adapters.
3. Run `node scripts/sync-templates.mjs` and commit.

### Refresh development latest explicitly

Development can deliberately follow npm's `latest` dist-tag. It is never
implicit: this command accepts only `--channel dev --latest`, rejects dirty
trees, verifies E2B credentials, builds a temporary generated Dockerfile,
boots the resulting image, and proves Node, Git, the CLI, every baked package,
and daemon `/health` before it writes any repository file:

```sh
pnpm templates:refresh --channel dev --latest
```

It records the new dev template ID and proved `baked` metadata in
`versions.json`, then runs canonical sync. It cannot publish or mutate
`templates.stable`; stable remains the explicitly pinned, reproducible release
path. The image publish itself cannot be undone if proof fails, but local
metadata is left untouched (and metadata/sync writes are rolled back on a
local partial failure), so the orphan can be inspected or removed safely.

Preview the registry resolution without publishing or changing files:

```sh
pnpm templates:refresh --channel dev --latest --dry-run
```

Verify generated drift and that the recorded dev bake exactly proves the
declared pins; this needs no E2B or npm credentials:

```sh
pnpm templates:refresh --channel dev --check
```

The command never injects host credentials into the Docker build or sandbox;
E2B authentication is used only by the host CLI. Agent/provider credentials
remain per-boot environment variables.

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

1. `agentproto --version` contains the `cli` pin (the output is
   `agentproto <semver> (sha, built ...)`, not bare semver).
2. Every baked adapter is globally installed — checked with
   `npm ls -g --depth=0 <pkg>` per adapter (`agentproto adapters list` shows
   ENABLED adapters from config, empty on a fresh bake, so it cannot prove
   installation).
3. `agentproto serve` answers `/health` on the provider's default port
   (18790).

These build-time checks are **necessary but not sufficient**: E2B can report a
build step `CACHED` against a stale layer, so the trusted proof is booting the
published image and inspecting `/usr/lib/node_modules/@agentproto` +
`agentproto --version` (with no on-boot `npm i -g`).
