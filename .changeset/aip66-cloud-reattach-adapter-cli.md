---
"@agentproto/adapter-claude-code-cloud": minor
"@agentproto/cli": minor
---

AIP-66 re-attach + adapter discoverability: the claude-code-cloud relay now advertises ACP `session/load` and implements it — the host hands back the vendor session id persisted on `meta.cloud.sessionId`, `session/load` ADOPTS it (repo-source validated first, an id that isn't `session_`/`cse_` fails closed), pre-marks the vendor's existing events so only the next turn's own `result` can end it, and the subsequent prompt goes through `sendPrompt` (`claude -p --cloud <id>`), never `startCloudSession` — a resumed relay can no longer start a replacement vendor session (AIP-66 §5). The learned identity is reported to the host through the `AGENTPROTO_CLOUD_SESSION_META_FILE` side file as exactly `{ vendor, sessionId, url }` (atomic temp+rename, best-effort), preserving an existing URL across a re-attach; the vendor's OAuth credential never enters it, logs or events (AIP-66 §8). The CLI lists `claude-code-cloud` in the bundled adapter catalog (`agentproto install` picker) and carries `@agentproto/adapter-claude-code-cloud` as a devDependency so the slug resolves like every other first-party adapter.
