# `agentproto pack`

```text
agentproto pack skill --manifest <path> [--source <dir>]
                      [--bump patch|minor|major] [--dry-run] [--out <dir>]
agentproto pack build [dir]
```

Generate a versioned skill pack from a manifest of source skills — the reverse
of [`agentproto install skill/<slug>`](./install.md). `pack skill` assembles a
pack directory from source; `install skill/<slug>` consumes one and installs it
into targets.

`pack build` builds a whole skill-pack **package** (for example
`packages/skill-pack-<name>`) from its `src/skills/` into the two shapes it
ships as: a flat npm layout (`skills/` + `.claude-plugin/` copied to the
package root) and a versioned Anthropic/Claude Code bundle under
`dist/<name>-v<version>/` plus its `.zip`. The version is taken from the
package's own `package.json` (the changesets source of truth), not from any
hand-declared manifest version.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--manifest <path>` | *(required)* | Path to the pack manifest JSON, resolved against the cwd. |
| `--source <dir>` | *(manifest `sourceDir`)* | Absolute source-skills dir. Wins over the manifest. `~` is expanded. |
| `--bump <kind>` | — | `patch`, `minor`, or `major` — bumps from the highest existing pack version in `--out`. Anything else exits `2`. |
| `--dry-run` | `false` | Print the plan (version transition, output dir, per-skill copy/overwrite/missing) and write nothing. |
| `--out <dir>` | `.skills` | Where pack directories are written, resolved against the cwd. |

## Manifest

```json
{
  "name": "agentproto-plugin",
  "description": "Operate and supervise a fleet …",
  "version": "0.3.0",
  "skills": ["slug1", "slug2"],
  "sourceDir": "${AGENTIK_STUDIO_ROOT}/.claude/skills",
  "author": { "name": "Name" },
  "keywords": ["kw1", "kw2"]
}
```

`name`, `description`, `version`, and `skills` are required — a missing or
mistyped one is a hard error. `author` defaults to `{ name: "agentproto" }` and
`keywords` to `[]`.

### Resolving `sourceDir`

`sourceDir` resolves relative to the **manifest file's own directory**, which
breaks when the source skills live in a different repo from the packager. Two
portable options, in precedence order:

1. `--source <absolute>` — one-off override, wins over everything.
2. `sourceDir: "${SOME_ENV_VAR}/.claude/skills"` — `${VAR}` is expanded against
   the environment before resolving, so one manifest works on any machine that
   sets the var. Referencing an **unset** var is a hard error, not a silently
   empty path.

Passing neither `--source` nor a manifest `sourceDir` exits `2`.

## What it writes

For each listed skill, `<sourceDir>/<skill>/` is copied wholesale to
`<out>/<name>-v<version>/skills/<skill>/`, then the pack's
`.claude-plugin/plugin.json` and `README.md` are regenerated from each
`SKILL.md`'s YAML frontmatter. A source skill with no `SKILL.md` is fatal.

The README is regenerated, not overwritten blind: the previous version's
"How it works" prose and existing changelog entries are carried forward, and a
`--bump` prepends a `- **<version>** — TODO: describe changes` entry for you to
fill in. Without `--bump`, the manifest's own `version` is used — re-running on
an existing version dir is an in-place resync.

## Examples

```bash
# See what would happen — no writes
agentproto pack skill --manifest ./skills-pack.json --dry-run

# Cut a patch release into ./.skills
agentproto pack skill --manifest ./skills-pack.json --bump patch

# Source lives in another repo; override for one run
agentproto pack skill --manifest ./skills-pack.json \
  --source ~/code/agentik-studio/.claude/skills --out ./dist/packs
```

```text
[dry-run] agentproto pack skill
  version: 0.3.0 → 0.3.1 (patch)
  output: /Users/me/code/proj/.skills/agentproto-plugin-v0.3.1
  source: /Users/me/code/agentik-studio/.claude/skills
  skills:
    + nested-orchestration — will copy
    ~ fleet-supervision — will overwrite
    ❌ retired-skill — SOURCE MISSING
```

## `build [dir]`

```bash
# Build the skill-pack package in the current directory
agentproto pack build

# Build a specific package directory
agentproto pack build packages/skill-pack-agentproto
```

Builds a skill-pack **package** from its own `package.json` version. It expects
`package.json` and `manifest.json` in the target directory (default cwd), runs
the same assembly logic as `pack skill`, then:

1. Copies `skills/` and `.claude-plugin/` flat to the package root for npm
   consumers.
2. Writes `dist/<name>-v<version>.zip` containing the self-contained versioned
   bundle for Claude Code / Anthropic consumers.

Fails with exit code `1` if `package.json` has no `version` or if either
required file is missing; exit code `2` for argument errors.

- [`install.md`](./install.md) — the consuming side: `install skill/<slug>`
- [`onboard.md`](./onboard.md) — installs the published pack on first run
