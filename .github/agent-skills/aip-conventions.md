# Skill: AIP conventions (@agentproto/ts house rules)

Apply these repo-specific rules to any review, fix, or PR you produce.

## Architecture
- This monorepo implements open agent standards (AIPs) as `@agentproto/*`
  packages. Each spec under `specs/` has a matching package. Keep code and spec
  in sync — a behavior change usually needs both.
- Tools are authored with `defineTool → implementTool → defineDriver` and
  projected to cli/http/mcp/sdk/mastra/ai-sdk. A new verb is new public surface.

## Changesets (changesets/changesets)
- Every PR that touches a published `@agentproto/*` package needs a changeset.
- Bump rules:
  - **patch** — bug fix, internal refactor, test, docs, CI, dep bump.
  - **minor** — new exported function/type/class, new optional parameter, new
    MCP tool verb, any backward-compatible feature.
  - **major** — removed/renamed export, incompatible signature change, breaking
    behavior.
- `scripts/**` and `.github/**` changes with no package export change get **no**
  changeset entry.
- Use `list_changed_packages` to ground the package list; do not guess from a
  truncated diff.

## Type safety
- No `any` in exported signatures. Prefer discriminated unions over boolean
  flags for multi-state inputs.
- `exactOptionalPropertyTypes` is on — spread optional props conditionally
  (`...(x ? { x } : {})`) rather than passing `undefined`.

## Tests
- New exported behavior needs a test. Bug fixes need a regression test that
  fails before the fix.
- Tests run via Vitest. Keep them deterministic — no real network, no clocks.

## Review tone
- Lead with correctness and type-safety findings; nits last and clearly labeled.
- Approve when the change is correct, typed, tested, and changeset-accurate.
  Request changes only for real defects, not style preferences.
