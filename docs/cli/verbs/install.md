# `agentproto install`

```text
agentproto install <adapter-slug>             [--force] [--dry-run] [--skip-setup]
agentproto install runtime-profile/<name>     [--force] [--dry-run] [--skip-setup]
                                              [--cwd <dir>] [--package <pkg>]
```

Two argument shapes routed through the same verb:

- `<adapter-slug>` — install an agent CLI adapter (e.g. `claude-code`).
- `runtime-profile/<name>` — install a runtime profile (file
  scaffolding for a swarm setup).

Both are idempotent and re-runnable; `--force` re-runs even when
already-installed checks pass.

## Adapter install

```bash
agentproto install claude-code
agentproto install hermes
agentproto install opencode --force          # reinstall ignoring version_check
agentproto install gemini-cli --dry-run      # print would-be steps
agentproto install goose --skip-setup        # install binary, skip post-install pipeline
```

Resolution: `<slug>` → `@agentproto/adapter-<slug>` from npm. The
adapter package must already be importable (typically via `npm i -g
@agentproto/adapter-<slug>` first). The CLI reads the adapter's
`AgentCliHandle` and walks its `install[]` block.

### Install methods supported

| Method | Status | Notes |
|--------|:--:|-------|
| `npm` | ✓ | `npm install [-g] <package>` |
| `brew` | ✓ | `brew install <package>` (supports `tap/repo/pkg` form) |
| `curl` | ✓ | Downloads `<url>`, optionally verifies `verify_sha256`, then `bash <script>`. Warns when no SHA is declared. |
| `download` | ✓ | Fetches archive (`.tar`/`.tar.gz`/`.tgz`/`.zip`), optionally verifies `verify_sha256`, extracts, copies `extract_bin` into `~/.local/bin` (or `$AGENTPROTO_BIN_DIR`), `chmod +x`. |
| `pip` | ✓ | `pip install [--user] <package>` |
| `cargo` | ✓ | `cargo install <package>` |
| `go` | ✓ | `go install <package>` |
| `apt` / `dnf` / `pacman` | ✗ | Privilege-escalation policy isn't defined yet. |
| `choco` / `scoop` | ✗ | Windows-only; not yet platform-detected. |
| `vendored` | ✗ | Needs a workspace root concept that the host CLI doesn't have yet. |

Methods are tried **in order until one succeeds**. So adapters can
ship an `npm` step followed by a `curl`/`download` fallback, and the
fallback fires automatically when npm isn't viable.

`experimental: true` steps are skipped by default — they're listed in
the output for visibility but not run.

### Idempotency

If the adapter declares a `version_check.cmd` + `version_check.parse`
regex, the CLI runs it before installing. When the binary answers,
the install short-circuits:

```
agentproto: 'claude-code' already installed (version 1.2.3). Pass --force to reinstall.
```

`--force` skips the check and re-runs every step.

### Post-install setup

After installation, if the adapter manifest declares a `setup[]`
block, the CLI runs it. This is the same engine `agentproto setup
<slug>` invokes standalone — see [`setup.md`](./setup.md) for the
step kinds and the idempotency model.

Skip with `--skip-setup`.

## Runtime profile install

```bash
agentproto install runtime-profile/standard
agentproto install runtime-profile/standard --cwd ./my-project
agentproto install runtime-profile/standard --dry-run
agentproto install runtime-profile/standard --force   # clobber user-edited files
```

Copies a declared file tree from a profile package into the current
directory (or `--cwd`). Each file has a merge strategy: `overwrite`,
`preserve`, `merge-json-deep`, `append`. The handler records what
landed in a ledger at `~/.agentproto/profiles/<name>.json`, so:

- Re-running the same version is a no-op.
- Files that match the ledger's `hashAfter` are overwritten on
  upgrade.
- Files that don't match (user-edited since last install) are
  reported as `user-edit` and left alone unless `--force`.

### `--package` and `profileAliases`

```bash
# Use a non-standard package for the profile
agentproto install runtime-profile/guilde --package @guilde/runtime-profile-guilde

# Or set it once in config so the flag isn't needed
agentproto config set profileAliases.guilde @guilde/runtime-profile-guilde
agentproto install runtime-profile/guilde
```

Resolution order for the npm package backing a profile slug:

1. `--package <name>` (explicit override)
2. `profileAliases[<slug>]` in `~/.agentproto/config.json`
3. Default convention: `@agentproto/runtime-profile-<slug>`

See [`../concepts/runtime-profiles.md`](../concepts/runtime-profiles.md).

## Examples

```bash
# First-time setup
npm i -g @agentproto/cli @agentproto/adapter-claude-code
agentproto install claude-code
agentproto run claude-code -p "hello"

# Multiple adapters
agentproto install hermes
agentproto install opencode

# Profile + swarm
agentproto install runtime-profile/standard
agentproto run-swarm --manifest .runtime/multi-agent.yaml --verbose
```
