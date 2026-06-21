# Agent skills

Markdown skill files injected into the harness agent's system prompt. Referenced
by name (without the `.md`) from `.github/agentic-review.json` — either the
top-level `skills` array (loaded into every flow) or a per-command
`commands.<cmd>.skills` override.

```jsonc
{
  "skills": ["aip-conventions"],            // default for all flows
  "commands": {
    "review": { "skills": ["aip-conventions", "ponytail-review"] }
  }
}
```

## Resolution order

1. **In-repo** — `name` with no `/` or `@` resolves to `.github/agent-skills/<name>.md`.
2. **External** — `owner/repo@skill` resolves only if it appears in
   `externalSkills.allow`; fetched at job time via `npx skills add` (best-effort,
   network-dependent). Vendor anything you need to be reproducible.

## Authoring

Keep skills short and imperative — they are concatenated into the system prompt,
so every token competes with the task. State *what to do* and *what to avoid*,
not background. See `aip-conventions.md` for the house style.
