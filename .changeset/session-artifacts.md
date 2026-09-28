---
"@agentproto/runtime": minor
---

feat(runtime): session-scoped artifact store — durable, content-addressed documents (image, pdf, html, presentation, site, file) attached to a session and kept across restarts. New `session_artifact_add`/`_list`/`_get`/`_pin` MCP tools, matching `/sessions/:id/artifacts*` HTTP routes (including a strict-CSP raw-serve route for html/site previews), `session:artifact-added`/`session:artifact-pinned-changed` lifecycle events, and pinned artifacts surface in a session's derived outcome as `type: "file"` refs.
