# Runtime profiles

A **runtime profile** is a bundle of file scaffolding the CLI can
drop into a user's repo to make a workflow work out of the box.
Today's profiles target Claude Code — they install sub-agent
definitions, hooks, slash commands, and example manifests under
`.claude/`.

Profiles are npm packages installed via:

```bash
agentproto install runtime-profile/<slug>
```

The handler reads the profile's `profile.json`, walks the declared
`files[]` array, and writes each entry with one of four strategies:

| Strategy             | Behavior                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `overwrite`          | Replace the file (refuses if the user edited since last install; `--force` overrides). |
| `preserve`           | Create only if absent — never touch an existing file.               |
| `merge-json-deep`    | Deep-merge with the existing JSON (arrays concat-and-dedup).        |
| `append`             | Append the source content to the target if not already present.     |

The handler records what landed in `~/.agentproto/profiles/<slug>.json`
so re-runs are idempotent and user edits aren't clobbered without
`--force`.

## Today's profiles

| Slug                          | Package                            | Scope                                              |
| ----------------------------- | ---------------------------------- | -------------------------------------------------- |
| `runtime-profile/standard`    | `@agentproto/runtime-profile-standard` | File-mode swarm scaffolding (reviewer agent, hooks, `/ap-swarm`) |

The "standard" profile is intentionally minimal — file-mode only,
no transport assumptions, no monorepo-specific paths. It's the
baseline anyone can install regardless of where they ship their
agents.

Transport-bridge profiles (Slack, hosted chat servers, MCP-bridged
threads) ship as separate `@<vendor>/runtime-profile-*` packages and
register their adapters through the [plugin
system](./plugins.md).

## Aliases for third-party profiles

The default resolver maps `runtime-profile/<slug>` to
`@agentproto/runtime-profile-<slug>`. To install a third-party profile
under a custom slug, use one of:

**Explicit `--package`:**

```bash
agentproto install runtime-profile/guilde \
  --package @guilde/runtime-profile-guilde
```

**Persistent alias** in `~/.agentproto/config.json`:

```jsonc
{
  "profileAliases": {
    "guilde": "@guilde/runtime-profile-guilde"
  }
}
```

Then:

```bash
agentproto install runtime-profile/guilde
```

## Authoring a profile

A runtime profile is an npm package that exports:

- `FILES_DIR: string` — absolute path to the files tree to copy
- `loadProfileManifest(): Promise<RuntimeProfileManifest>` — reads
  the package's `profile.json`

The manifest shape (`agentproto/runtime-profile/v1`):

```jsonc
{
  "schema": "agentproto/runtime-profile/v1",
  "slug": "runtime-profile/<your-slug>",
  "version": "0.1.0",
  "name": "Human-readable name",
  "description": "What this profile drops into a repo.",
  "files": [
    {
      "src": ".claude/agents/your-agent.md",
      "dest": ".claude/agents/your-agent.md",
      "strategy": "overwrite"
    },
    {
      "src": ".claude/hooks/your-hook.mjs",
      "dest": ".claude/hooks/your-hook.mjs",
      "strategy": "overwrite",
      "executable": true
    },
    {
      "src": ".claude/settings.json",
      "dest": ".claude/settings.json",
      "strategy": "merge-json-deep"
    }
  ]
}
```

`executable: true` flips the mode bits to 0755 after copy — needed for
hooks Claude Code spawns directly.

## Ledger

After every install the handler writes the per-file outcome to
`~/.agentproto/profiles/<slug>.json`:

```jsonc
{
  "slug": "runtime-profile/standard",
  "version": "0.1.0",
  "installedAt": "2026-05-24T01:30:00.000Z",
  "updatedAt": "2026-05-24T01:30:00.000Z",
  "files": [
    {
      "dest": ".claude/agents/reviewer.md",
      "strategy": "overwrite",
      "hashAfter": "<sha256>",
      "appliedAt": "<iso>"
    }
  ]
}
```

The ledger powers the user-edit detection: if a file's current hash
differs from `hashAfter`, the user edited it and the next install
preserves it (action `user-edit`) unless you pass `--force`.
