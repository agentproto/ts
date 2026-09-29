# @agentproto/command-sandbox

## 0.3.0

### Minor Changes

- 6a1bedc: App-spawned sessions (`app_run`, and workflow agent steps whose workflow carries an `appId`) now get filesystem zones: the installed app source is read-only, the run workspace and app `data/` dir are writable, everything else is denied. Enforced on the daemon's own file/command tools always; on the harness's native tools (claude-code) via `@agentproto/command-sandbox` zoned mode plus host `CLAUDE.md`/`AGENTS.md` exclusion when the adapter and OS sandbox support it. Apps opt into `boundaries: { enforce: "required" }` in `defineApp`/`APP.md` to refuse a spawn instead of silently downgrading when native enforcement isn't available.

## 0.2.2

### Patch Changes

- fee0522: Test-only: add runtime capability probes (Seatbelt nesting, loopback bind) so environment-dependent suites skip with a clear reason instead of failing in confined environments.

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.0

### Minor Changes

- c506d87: Extract OS-level process confinement (macOS Seatbelt / Linux bubblewrap) into shared `@agentproto/command-sandbox` package to resolve circular dependency, enabling both `command_execute` tool and adapter child processes to use identical backends. Add `extraWritePaths` support for write-capable directories (e.g., toolchain self-managed installs), and empirically-validated metadata-only `$HOME` allow for npm/npx compatibility. Apply confinement to agent-cli spawns in both ACP/MCP and print-protocol arms.
- 392021a: Add config-file surface and `agent_start` MCP exposure for adapter-spawn command sandboxing (PR 6b continuation):
  - **Config-file surface**: New `.agentproto/command-sandbox.json` `adapterSpawn` key (distinct from `command_execute`'s top-level `mode`) with separate env-var escape hatch (`AGENTPROTO_ADAPTER_COMMAND_SANDBOX_MODE`) to control adapter-spawn confinement persistently, justifying explicit opt-in due to larger blast radius.
  - **MCP exposure**: `commandSandbox?: "off" | "workspace" | "strict"` added to `agent_start` schema; forwarded through runtime and driver layers.
  - **Bug fix**: `serve.ts` was silently dropping `commandSandbox` from the opts destructure; fixed by including it in the spread and adding the type to `AgentAdapterResolver.startSession`.
  - **Credential access gap** (PR 6a follow-up): Added read-only paths to adapter-spawn defaults (`~/.gitconfig`, `~/.config/git`, `~/.config/gh`, `~/Library/Keychains`) fixing `git ls-remote` and `gh auth status` failures under `workspace` mode confinement.
  - **Async change**: `wrapAgentCliSpawn()` now async to support config-file loading; all callers updated.

  Backwards compatible: default behavior unchanged when no config and no explicit mode.
