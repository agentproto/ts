---
"@agentproto/runtime": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-claude-code": patch
---

Skill imports: a per-session skill registry + delivery, mirroring the MCP-import model.

- `@agentproto/runtime` gains `skill-imports.ts` (`~/.agentproto/imported-skills.json`; import COPIES a `SKILL.md` folder into `~/.agentproto/skills/<id>/` with a content sha, snapshot-not-symlink), the `skill_import` / `skill_imported_list` / `skill_imported_remove` / `skill_resync` MCP tools, and spawn-time resolution (`resolveSessionSkills`) that turns the resolved `skills` list into concrete `sessionSkills` entries — non-imported ids warn (never throw) and stay in the adapter-facing list unchanged.
- `@agentproto/driver-agent-cli` gains `AgentCliStartOptions.sessionSkills` and the adapter-manifest `metadata.sessionSkills` field (`{ dir, env? }`); before the child starts it copies each resolved skill into `<session configDir>/<dir>/<alias>/`, wiping stale entries first.
- `@agentproto/adapter-claude-code` delivers into `$CLAUDE_CONFIG_DIR/skills/` (no env needed). `@agentproto/adapter-opencode` delivers into `<configDir>/skills/` and points `OPENCODE_CONFIG_DIR` at it — the only route that survives `lean` mode's `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, which gates opencode's auto-discovery but not its config-dir skill scan.
