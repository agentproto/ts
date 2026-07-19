# Authoring agentproto skills (AIP-3) — source homes & how to apply

How to create a skill, WHERE it lives source-side, and how it gets applied.
Grounded in `projects/agentproto/ts` (`packages/skill`, `packages/skill-pack-*`,
`packages/cli/src/commands/{pack,install-skill}.ts`).

---

## The three homes (don't confuse them)

A "skill" is an **AIP-3 `SKILL.md`** (markdown + frontmatter). There are three
distinct places a skill can live, for three purposes:

| Home | Path | Purpose | Edited by hand? |
|---|---|---|---|
| **Pack source of truth** | `packages/skill-pack-agentproto/src/skills/<slug>/SKILL.md` | THE centralizing store — publishable, versioned, installable into any agent | ✅ yes — the only place you edit |
| **Generated pack output** | `.../skill-pack-agentproto/skills/<slug>/` + `.claude-plugin/plugin.json` + `dist/<name>-v<ver>.zip` | what consumers install | ❌ never — `pnpm build` generates it |
| **CI-lane skills** | `agentproto/ts/.github/agent-skills/<name>.md` | short prompts injected into the review/fix harness, referenced from `agentic-review.json` | ✅ yes (separate mechanism) |

Plus a fourth, downstream: the **studio harness install** —
`agentik-studio/.claude/skills/<slug>/` + `.agents/skills/<slug>/` — is where
Claude Code loads skills locally. **It is a CONSUMER, not a source.** It can
drift from the pack whenever it's edited directly instead of via the pack
`src/skills/`. Source of truth = the pack.

> **Rule of thumb:** a skill that teaches an agent to *operate agentproto* →
> the **pack** (`skill-pack-agentproto/src/skills/`). A short imperative rule
> for the *PR review/fix bots* → **`.github/agent-skills/`**. A local-only
> Claude Code helper for THIS studio repo → studio `.claude/skills/` (accept it
> won't ship to other agents).

---

## The AIP-3 SKILL.md format (`@agentproto/skill`, `packages/skill/src/schema.ts`)

```markdown
---
name: my-skill            # REQUIRED. 1–64 chars, [a-z0-9-], no leading/trailing/
                          #   consecutive hyphens. MUST equal the parent dir name.
description: >            # REQUIRED. 1–1024 chars. Say WHAT it does AND WHEN to use it
  One paragraph: what this skill does and the triggers that should invoke it.
# --- all optional ---
license: Apache-2.0
compatibility: "Needs the agentproto daemon on :18790"   # free-form env requirements
allowed-tools: "Bash(git:*) Read"    # space-separated pre-approved patterns (a request, not a grant)
metadata:
  aip3:                   # AIP-3 extensions (win over top-level on AIP-3 runtimes)
    author: "Name <email>"
    title: "Human Display Title"     # body H1 is preferred over this
    uses: ["other-skill"]            # skills this composes with (required if variant=composite)
    # execution: { ... }             # optional executable-skill block
  tags: my, skill, tags   # loose metadata is allowed (`.loose()` schema)
---

# My Skill

The body IS the skill content — imperative, what-to-do / what-to-avoid. The H1
is the preferred display title. Sub-directories (e.g. `reference/`, assets) next
to SKILL.md travel with the skill when packed.
```

Key constraints (enforced by the zod schema):
- `name` **MUST equal the parent directory name** (`skills/my-skill/SKILL.md` →
  `name: my-skill`). Mismatch = build/validate error.
- `description` carries the routing signal — write it as "does X; use when Y".

---

## Authoring in the pack (the centralized path)

```
packages/skill-pack-agentproto/
├── manifest.json          # { name: "agentproto-plugin", skills: [...slugs], sourceDir: "./src/skills" }
├── package.json           # version = source of truth (changesets); NOT in manifest
├── src/skills/<slug>/SKILL.md   ← EDIT HERE ONLY
├── skills/                ← generated (flat, npm consumer)
└── .claude-plugin/plugin.json   ← generated (Claude Code plugin)
```

To add a skill:
1. `mkdir packages/skill-pack-agentproto/src/skills/<slug>/` and write `SKILL.md`
   (+ any `reference/`/assets).
2. Add `<slug>` to `manifest.json` `skills[]` (order = display order).
3. Build: `pnpm --filter @agentproto/skill-pack-agentproto build`
   — regenerates `skills/`, `.claude-plugin/plugin.json`, and
   `dist/agentproto-plugin-v<version>/` + `.zip`. Version comes from the
   package's own `package.json` (changesets), never hand-declared.
4. **Never** edit `skills/` or `.claude-plugin/` directly — they're overwritten.

Cross-repo source: `agentproto pack skill` also supports a manifest
`sourceDir: "${SOME_ENV_VAR}/.claude/skills"` — expands `${VAR}` against
`process.env` so a pack can pull skills from a *different* (e.g. private) repo's
`.claude/skills`. The agentproto-plugin pack keeps its own `src/skills/`.

---

## Applying / installing a skill

### Via agentproto
```bash
# From a named pack (repo-local .skills, ~/.agentproto/packs, or npm):
agentproto install skill/<slug> --pack agentproto-plugin

# Once the pack is published to npm, bare resolution works:
agentproto install skill/<slug>          # resolves @agentproto/skill-pack-agentproto
```

**Pack resolution order** (`skill-install/pack-resolve.ts`):
1. `--pack <path>` → used verbatim (home-expanded)
2. `--pack <name>` → `~/.agentproto/packs/<name>/`, then `<repoRoot>/.skills/<name>/`, then npm dual-naming
3. omitted → legacy glob `.skills/agentproto-plugin-v*` (highest semver) —
   note `.skills/` is no longer committed; produce it with
   `agentproto pack skill --out .skills` first.

**Target resolution** (`install-skill.ts`):
- `--target hermes|claude-code|claude-desktop` → install into that one target.
- omitted → **fan-out**: install into EVERY installed CLI adapter that declares
  a `metadata.skills` block (adapters without one are skipped, informationally —
  not an error).

### Via Claude Code / Anthropic (no agentproto)
Install the `dist/agentproto-plugin-v<version>.zip` bundle attached to the
package's GitHub release (built by `.github/workflows/release.yml`). Same
skills, same `src/skills/` source — just the plugin-bundle shape.

---

## CI-lane skills (the OTHER mechanism — `.github/agent-skills/`)

Separate from the pack: flat `<name>.md` files concatenated into the PR
review/fix harness system prompt, referenced by name from `agentic-review.json`:
```jsonc
{ "skills": ["aip-conventions"],
  "commands": { "review": { "skills": ["aip-conventions", "ponytail-review"] } } }
```
Resolution: in-repo `name` → `.github/agent-skills/<name>.md`; external
`owner/repo@skill` only if listed in `externalSkills.allow` (fetched at job time
via `npx skills add`, network-dependent — vendor anything that must be
reproducible). Keep these SHORT and imperative — every token competes with the
task. (The sandboxed lanes read them from the clone via `skillsBlock`, see
`reference/ci-review-fix-lanes.md`.)

---

## Drift & reconciliation

The studio `.claude/skills/<slug>/` (and `.agents/skills/<slug>/` mirror) is a
local install. Editing it does NOT update the pack — to centralize a change,
port it into `packages/skill-pack-agentproto/src/skills/<slug>/`, rebuild, and
ship it (agentproto/ts PR flow). When they disagree, the **pack `src/skills/` is
authoritative**; the studio copy is a materialized install that may lag.

Checklist for a new pack skill:
- [ ] `src/skills/<slug>/SKILL.md`, `name:` == `<slug>`, description says what+when
- [ ] slug added to `manifest.json` `skills[]`
- [ ] `pnpm --filter @agentproto/skill-pack-agentproto build` green
- [ ] changeset (the reviewer writes it) — bump the pack package
- [ ] PR to `agentproto/ts`; do NOT hand-edit `skills/` or `.claude-plugin/`
