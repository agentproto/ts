# agentproto-workstation e2b template

Declarative build for the pre-baked e2b template `@agentproto/sandbox-e2b`
boots by default. Everything it bakes is pinned in
[`versions.json`](./versions.json) — the single source of truth:

- `cli` — the `@agentproto/cli` version
- `adapters` — the agentproto adapter packages (with their pins)
- `runtime` — agent runtime CLIs (`opencode-ai`)
- `sizes` — named size presets (`cpuCount` / `memoryMb`), each published as
  its own template, plus `defaultSize` (see [Sizes](#sizes)). These are passed
  as `e2b template create` **flags** (`--cpu-count` / `--memory-mb`), NOT read
  from any toml — see [Build](#build).
- `templates.stable` / `templates.dev` / `templates.sizes.<preset>` —
  published e2b template id + alias, plus the `baked` block recording what the
  published image was PROVEN to contain (`cli`, `adapters`, `builtAt`; all
  null = unproven bake)
- `tools` — standalone binaries baked from pinned release tarballs:
  `tools.gh` is the GitHub CLI (`version` + the `sha256` of the
  `linux_amd64` tarball from the release's `checksums.txt`; the build fails
  on a mismatch). Sandbox agents use it for `gh pr create` with the
  daemon-injected `GH_TOKEN` (see the `@agentproto/sandbox-e2b` README)
- `baseImage` — the image the Dockerfile builds `FROM`

Derived files (the generated TS module, marked doc blocks, and
`e2b.template.toml`'s build args) are regenerated with:

```sh
node scripts/sync-templates.mjs          # write
node scripts/sync-templates.mjs --check  # CI gate — non-zero on drift
node scripts/sync-templates.mjs --dry-run
```

## Sizes

Every size preset in `versions.json` is published as its own e2b template,
`agentproto-workstation-<size>`, and a spawn picks one with `config.size`:

```ts
agent_start({ sandbox: { provider: "e2b", config: { size: "large" } } })
```

<!-- sync-templates:sizes:start -->
| size | vCPU | RAM (MB) | e2b alias | status |
|---|---|---|---|---|
| `nano` | 1 | 1024 | `agentproto-workstation-nano` | published |
| `small` | 2 | 2048 | `agentproto-workstation-small` | published |
| `medium` | 2 | 4096 | `agentproto-workstation-medium` | published |
| `large` (default) | 4 | 8192 | `agentproto-workstation-large` | published |
| `x-large` | 8 | 16384 | `agentproto-workstation-x-large` | **unavailable** — e2b refused: `400: Memory can't be higher than 8192 MiB (if you need to increase this limit, please contact support)` |
| `xx-large` | 16 | 32768 | `agentproto-workstation-xx-large` | **unavailable** — e2b refused: `400: CPU count can't be higher than 8 (if you need to increase this limit, please contact support)` |

The bare `agentproto-workstation` alias (and `agentproto-workstation-dev`) is built at
the default size, `large` (4 vCPU / 8192 MB).

Create commands (run from `templates/workstation/`; the flags are REQUIRED):

```sh
e2b template create agentproto-workstation --cpu-count 4 --memory-mb 8192 -d Dockerfile   # bare alias = large
e2b template create agentproto-workstation-dev --cpu-count 4 --memory-mb 8192 -d Dockerfile   # dev channel = large
e2b template create agentproto-workstation-nano --cpu-count 1 --memory-mb 1024 -d Dockerfile
e2b template create agentproto-workstation-small --cpu-count 2 --memory-mb 2048 -d Dockerfile
e2b template create agentproto-workstation-medium --cpu-count 2 --memory-mb 4096 -d Dockerfile
e2b template create agentproto-workstation-large --cpu-count 4 --memory-mb 8192 -d Dockerfile
# unavailable on the current e2b plan:
# e2b template create agentproto-workstation-x-large --cpu-count 8 --memory-mb 16384 -d Dockerfile
# unavailable on the current e2b plan:
# e2b template create agentproto-workstation-xx-large --cpu-count 16 --memory-mb 32768 -d Dockerfile
```
<!-- sync-templates:sizes:end -->

**A full `pnpm build` + `pnpm test` of agentproto/ts needs `large` or
bigger.** Smaller boxes OOM-killed agent sessions mid-build (claude-code + the
in-box daemon + the build + vitest workers all share the box's RAM): at 4096 MB
a parallel `pnpm build` outgrew the box, its daemon was OOM-killed mid-session
(2026-10-13) and the box wedged, losing the work. The provider also adds a 4 GiB
swap file on boot (`swapMb`, `@agentproto/sandbox-e2b`), which turns a slightly
oversized build into a slow one rather than a dead box. Use `small`/`medium` for single-package work and
`nano` for light tasks with no build.

The provider also sizes Node builds to the preset: pnpm runs one package build
per vCPU and each tsup DTS worker takes Node's default heap, so on boot it
derives `NODE_OPTIONS=--max-old-space-size=…` plus
`npm_config_workspace_concurrency` / `TURBO_CONCURRENCY` from the box
(`buildEnv` in `@agentproto/sandbox-e2b` to override, `false` to disable) and
ships them through the daemon's start env and `/etc/profile.d/agentproto-build.sh`
— a parallel build throttles itself instead of OOM-ing, and a caller-provided
`NODE_OPTIONS` still wins.

`x-large` / `xx-large` stay declared with `available: false` and the exact
e2b refusal: the current e2b plan caps a sandbox at 8 vCPU / 8192 MB. Asking for
an unavailable size fails at boot with that error instead of silently booting a
smaller box. Once the plan limit is raised, publish the template, record its id,
and drop `available` / `unavailableReason`. e2b has no GPU sandboxes
(Firecracker has no PCIe passthrough, and `e2b template create` has no GPU
option), so there is no GPU preset.

## Build

Requires the [e2b CLI](https://e2b.dev/docs/cli) (`npm i -g e2b@latest`) and
`e2b auth login` (or `E2B_ACCESS_TOKEN`) on the building machine. **No build
runs from this repo's CI — publishing is a deliberate, credentialed act.**

```sh
cd templates/workstation
e2b template create agentproto-workstation --cpu-count 4 --memory-mb 8192 -d Dockerfile
```

That is the bare alias, built at the default size. The per-size commands are
generated into [Sizes](#sizes) and `e2b.template.toml`.

**The `--cpu-count` / `--memory-mb` flags are required, not optional.** `e2b
template create -d Dockerfile` builds the Dockerfile directly and does **not**
read `e2b.template.toml` (the e2b CLI's own config file is `e2b.toml`; ours is a
record only), so the `cpu_count` / `memory_mb` keys recorded there are ignored
at build time — resources come only from the flags. The e2b default is **512 MB**,
which OOMs the mastra adapter's runtime install and wedges the box. Each
preset's `cpuCount` / `memoryMb` in `versions.json` is what the generator
threads into its documented build command. Keep the flag values in sync with
`versions.json`: re-run `node scripts/sync-templates.mjs` and use the commands
it records here and in `e2b.template.toml`.

The e2b CLI has **no `--build-arg`** (`e2b template build` is deprecated in
favour of `e2b template create`), so the pins are baked into the Dockerfile's
`ARG` defaults by `scripts/sync-templates.mjs` — one ARG per package, never a
space-separated list (E2B rewrites each `ARG` into an `ENV` and mangles spaces
in ENV values). When `versions.json` changes, re-run
`node scripts/sync-templates.mjs` first so the generated `Dockerfile` (and the
`e2b.template.toml` pin record) match the new pins.

### Dev variant

The dev channel is the **same generated Dockerfile** published under the
`-dev` alias at the default size (the pins differ only when `versions.json`
declares different ones):

```sh
e2b template create agentproto-workstation-dev --cpu-count 4 --memory-mb 8192 -d Dockerfile
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

Verify generated drift and that the recorded channel proofs exactly match the
declared pins; this needs no E2B or npm credentials:

```sh
pnpm templates:refresh --channel dev --check
```

### Refresh the stable channel from its pins

Stable never resolves npm's `latest`. `--channel stable --pin` bakes **exactly**
the versions already declared in `versions.json` (the same `cli`, `adapters`,
and `runtime` pins the generated Dockerfile builds from), then runs the **same
proof gate as the dev flow**: it boots the published image and proves Node,
Git, the CLI, every baked adapter and runtime package, and daemon `/health`
before writing anything. It refuses `--latest` outright — a stable refresh can
only re-bake the recorded pins (typically after bumping them by editing
`versions.json` and re-running the sync script), never drift to whatever the
registry currently serves:

```sh
pnpm templates:refresh --channel stable --pin [--dry-run]
```

Without `--size` it refreshes the bare `agentproto-workstation` alias (built
at `defaultSize`). `--size <preset>` refreshes one size template instead, and
`--size all` refreshes the bare alias plus every available preset (an
unavailable preset is skipped with its recorded e2b error; naming one explicitly
fails). Every proof also checks `nproc` / `free -m` inside the box against
the preset:

```sh
pnpm templates:refresh --channel stable --pin --size small
pnpm templates:refresh --channel stable --pin --size all
```

It records the new stable template ID and proved `baked` metadata in
`versions.json`, re-runs canonical sync, and leaves `templates.dev` untouched
(the dev flow symmetrically never touches stable). Bump a stable pin by
editing `versions.json` first; the `--pin` flow then bakes and proves the new
pins in one pass.

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
3. `gh --version` reports the `tools.gh` pin.
4. `agentproto serve` answers `/health` on the provider's default port
   (18790).

These build-time checks are **necessary but not sufficient**: E2B can report a
build step `CACHED` against a stale layer, so the trusted proof is booting the
published image and inspecting `/usr/lib/node_modules/@agentproto` +
`agentproto --version` (with no on-boot `npm i -g`).
