# One place for your agents' MCP servers, skills and memory

Every coding agent keeps its own list of MCP servers, its own skills folder
and its own memory. Add a server to Claude Code and Codex never hears of it;
write a skill for one harness and the others cannot see it.

agentproto already runs a daemon that sits above all of them, so it can hold
**one** copy of each thing and hand it to whichever agent you start. This
guide shows how, with commands you can paste, and says plainly where a given
harness cannot take part.

All examples assume a daemon on `http://127.0.0.1:18790` started with
`agentproto serve` (see [mcp-in-coding-cli.md](./mcp-in-coding-cli.md)).

```bash
DAEMON=http://127.0.0.1:18790
# The per-boot bearer token the daemon writes next to its workspace.
TOKEN=$(node -p "require('./.agentproto/runtime.json').token")
AUTH="Authorization: Bearer $TOKEN"
```

The read routes in steps 1 to 4 need no token. Anything that writes (import,
bundles) and the artifacts route send `$AUTH`.

---

## 1. Import an MCP server once

The daemon discovers MCP servers that are already configured for your other
tools (Claude Code, Cursor, Codex, goose, and a workspace `.mcp.json`):

```bash
curl -s $DAEMON/mcps/discovered
```

Each entry has an `id` such as `claude-code:global:demo-echo`. Import the
ones you want to share:

```bash
curl -s -X POST $DAEMON/mcps/imports \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"sourceMcpId":"claude-code:global:demo-echo","alias":"echo"}'

curl -s $DAEMON/mcps/imports        # what is imported now
```

The import is stored in `~/.agentproto/imported-mcps.json`. Header and env
values that look like secrets are moved to your OS keychain, and the file only
keeps references. The same two steps exist as MCP tools for an agent to call
(`mcp_discovered_list`, then `mcp_import`).

There is no `agentproto mcp import` command today. The CLI only has
`agentproto mcp mount-default` and `agentproto mcp migrate-secrets`.

### Make an MCP the default for one harness

```bash
agentproto mcp mount-default claude-code claude-code:global:demo-echo
```

From then on every `claude-code` spawn mounts that server as a native MCP
server, with no per-spawn argument. Under the hood this writes a managed
bundle called `harness-claude-code` and links it in `~/.agentproto/config.json`.
Repeat the command to add more ids.

## 2. Create a bundle and attach it to a spawn

A bundle is a named set of imported MCP servers plus skill names. Use it when
you want a set for one job instead of a default for every spawn.

```bash
curl -s -X POST $DAEMON/bundles \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{
    "id": "research",
    "label": "Research",
    "mcpImports": ["claude-code:global:demo-echo"],
    "skills": ["web-research"]
  }'

curl -s $DAEMON/bundles
```

`mcpImports` takes import ids, or `"*"` for every import at spawn time. Ids
are lowercase kebab-case. A bundle can also set `"includeDaemon": true` to
mount the daemon's own `/mcp` next to the imports.

Attach the bundle when you start an agent:

```bash
curl -s -X POST $DAEMON/sessions/agent \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"adapter":"claude-code","cwd":"'"$PWD"'","bundles":["research"]}'
```

The MCP equivalent is `agent_start({ adapter, bundles: ["research"] })`. The
`agentproto sessions start` command has no `--bundles` flag yet, so use the
default mount from step 1, or call the route or tool above.

Each imported MCP reaches the agent as its own server with its native tool
names, through the daemon at `/mcp/imported/<id>`. The daemon keeps the
upstream credentials; the agent only sees a daemon URL.

If a bundle names an import that was removed since, the spawn still succeeds
and reports a warning for the skipped entry. `GET /bundles` shows such ids in
a `dangling` array.

## 3. Install a skill for the harnesses that read files

Skills are folders with a `SKILL.md`. To put one where every supporting
harness looks for it:

```bash
agentproto install skill/web-research --pack ./my-skill-pack --dry-run
agentproto install skill/web-research --pack ./my-skill-pack
agentproto install skill/web-research --pack ./my-skill-pack --list   # list the pack's skills
```

`--pack` accepts a local path, a pack name, `npm:<pkg>` or `github:<owner>/<repo>`.
The install writes into each harness's own format:

| Harness | Where it lands |
|---------|----------------|
| `claude-code` | a plugin under `~/.claude/plugins/agentproto` (you still run `/plugin marketplace add` once) |
| `hermes` | `~/.hermes/skills` |
| `opencode` | `~/.config/opencode/skills` |

Harnesses with no skills target are skipped and the command prints why:
`codex`, `gemini`, `copilot-cli`, `grok-cli`, `pi`, `antigravity`, `openclaw`,
`jcode`, `claude-sdk` and the `mastra*` family.

## 4. See what a session actually received

Two read-only views answer "what does this agent really have?".

**One session.** Everything mounted on it, in one call:

```bash
curl -s $DAEMON/sessions/<session-id>/capabilities
```

```json
{
  "sessionId": "sess_a37ec634",
  "adapter": "fake-acp",
  "arm": "acp",
  "mcpServers": [
    { "name": "echo", "transport": "http", "ref": "http://127.0.0.1:18790/mcp/imported/claude-code%3Aglobal%3Ademo-echo?callerSessionId=sess_a37ec634" }
  ],
  "skills": ["web-research"],
  "skillsApplied": false,
  "permissionHold": false,
  "pendingPermissions": 0
}
```

(Trimmed. The full body also lists slash commands, modes and postures.) The
MCP tool is `session_capabilities`. It never returns headers, env or
credentials, only name, transport and URL.

Read `skillsApplied` carefully. `skills` records what was requested.
`skillsApplied` is `true` only when the harness takes a skills list at spawn,
which today is `hermes` alone. For the others the list is informational, and
the harness only sees skills already installed on disk (step 3).

**The whole daemon.** Which MCP servers are imported, whether they are
reachable, how each harness reaches them by default, and which skills are
installed per harness:

```bash
curl -s $DAEMON/capabilities/inventory
```

For each import, `reach` maps every installed harness to `native` (a default
bundle mounts it), `indirect` (only through the daemon's `/mcp` and the
`mcp_imported_call` tool) or `none`. `usedBySessions` lists live sessions
using it, and `alsoNativeIn` flags a server that a harness also mounts on its
own, which usually means duplicate tools. The MCP tool is
`capabilities_inventory`. Bundles are not part of this read; list them with
`GET /bundles`.

The VS Code extension shows the same data in a read-only **Capabilities** view
next to Sessions: imported MCP servers, bundles, skills per harness, and, for
the session you select, what it received.

## 5. Shared memory and artifacts

### Memory: search past sessions

The daemon indexes the transcripts of finished sessions into a per-workspace
brain. Query it from any shell, without an MCP client:

```bash
agentproto brain query "worktree gc"
agentproto brain query "flaky test" --workspace my-project --topk 5 --json
```

Agents reach the same index through the `workspace_brain_query` tool;
`workspace_brain_status` shows how much is indexed and how many sessions are
still pending, and `workspace_brain_ingest` indexes one on demand. By default
this is keyword search (BM25) over transcripts only. A workspace can add more
sources in `~/.agentproto/workspaces/<slug>/knowledge.json`: a folder of
files (`files`), a gbrain document store (`gbrain-doc`) or a Qdrant collection
(`qdrant`). The `corpus` provider id is reserved but not implemented, and
`code-brain-gbrain` is not wired into the daemon yet.

### Artifacts: keep what an agent produced

Documents, images, PDFs, HTML and sites attached to a session are stored by
content hash, versioned by key, and survive restarts:

```bash
# from an agent or script, over MCP
session_artifact_add   { "idOrName": "<id>", "sourcePath": "/abs/notes.md", "key": "notes", "label": "Notes" }
session_artifact_list  { "idOrName": "<id>" }

# or read over HTTP
curl -s -H "$AUTH" $DAEMON/sessions/<session-id>/artifacts
```

`session_artifact_get` returns a version's content and `session_artifact_pin`
pins one. Re-adding the same key with new bytes records version 2; identical
bytes are a no-op.

### Settings: move the setup to another machine

```bash
agentproto settings export --out my-setup.json
agentproto settings import my-setup.json --dry-run
agentproto settings import my-setup.json
```

Import only adds. Anything that already exists locally is left alone and
reported as skipped. Secrets are never included unless you ask
(`--include-secrets <profile-id> --passphrase-env <VAR>`). Imported-MCP
entries travel as pointers with env and header values stripped.
`~/.agentproto/bundles.json` is **not** in the export, so recreate bundles on
the new machine (or a `defaults.bundles` entry in your config will name a
bundle that does not exist there).

## 6. Honest limits

- **Native MCP mounts need an ACP harness.** Only adapters that speak the ACP
  protocol accept an MCP server list at session start. Print-mode and
  proprietary adapters get no mounts from a bundle. `adapter_list` shows each
  adapter's protocol.
- **Sandboxed spawns skip MCP mounts.** A session started in a sandbox does
  not receive bundle servers.
- **Skills are applied at spawn by `hermes` only.** Claude Code and opencode
  read skills installed on disk beforehand. Codex, Gemini and the others in
  step 3 have no install target, so a bundle's `skills` list does nothing for
  them.
- **An explicit `skills` list replaces the defaults.** It is not merged with
  the `defaults.skills` from your config.
- **Memory is transcript search by default.** It is keyword matching over past
  sessions, not a curated knowledge base, until you add providers in
  `knowledge.json`.
- **Writes need the per-boot token.** The token changes on every daemon start.
  Never reuse one across restarts, and never paste it into a shared place.
- **No import or bundle CLI yet.** Both go through the HTTP routes shown above,
  the MCP tools (`mcp_import`, `bundle_create`, `bundle_update`,
  `bundle_delete`) or the configuration app.
