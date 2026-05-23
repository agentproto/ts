# @agentproto/corpus-cli

Local-topology host for the AIP-10 corpus runtime. Exposes a `corpus` binary that validates, lints, and operates a corpus workspace on disk — pair with a local backing engine (qdrant docker / gbrain) for a fully offline corpus.

## Quick start

```bash
pnpm add -g @agentproto/corpus-cli

corpus init marketing ./my-corpus      # scaffold a starter workspace
corpus validate ./my-corpus             # validate every AIP file
corpus lint ./my-corpus                 # run KNOWLEDGE.md-declared lints
corpus events:emit corpus.entry.promoted --payload '{"slug":"foo"}' ./my-corpus
corpus events:tail ./my-corpus          # tail _log.md
```

## Status (M14)

Minimum-viable local host:

- `corpus init <vertical> [path]` — seed a starter workspace
- `corpus validate [path]` — JSON Schema check across every AIP file
- `corpus lint [path]` — run the lints declared in KNOWLEDGE.md
- `corpus events:emit <kind> --payload <json> [path]` — append an event to `_log.md`
- `corpus events:tail [path]` — print `_log.md`

Coming in M14.1:

- `corpus serve` — MCP server on a local socket
- Docker-managed local qdrant
- Ollama-backed LLM-judge evaluator
- `corpus query` against the backing engine
- `corpus reindex` / `corpus import`

## Architectural seam

The CLI is the **local-topology** host for `@agentproto/corpus`. The kit is pure and consumes ports; this package supplies the concrete `FsPort` (node:fs) and `IdentityPort` (OS user + cwd). The agstudio side ships its own host (`projects/guilde/apps/api/services/corpus-host.ts`) for the cloud topology — same kit, different wiring.
