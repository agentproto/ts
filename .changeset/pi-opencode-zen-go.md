---
"@agentproto/adapter-pi": minor
---

Run OpenCode Zen (`opencode/<id>`) and OpenCode Go (`opencode-go/<id>`) models on pi. Both route tables join pi's model menu from the shared catalog, and api-key profiles on either endpoint land in `OPENCODE_API_KEY`. A Go profile pinned to an OpenCode console org now authenticates like the opencode adapter: the org's provider block is translated into a per-session pi provider override (bearer `${OPENCODE_CONSOLE_TOKEN}` plus the `x-opencode-org-id` header, env references only) applied by a shipped `provider-overrides-extension.mjs`.
