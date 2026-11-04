---
"@agentproto/harness": minor
"@agentproto/acp": patch
"@agentproto/adapter-codex": patch
---

Surface codex `request_user_input` as an AIP-45 structured question under permission hold. A new `permissionHoldConfig` manifest field lets an agent-cli definition deep-merge inline JSON config into its config env var only for a `permissionHold` session; adapter-codex uses it to enable codex's `default_mode_request_user_input` feature through `CODEX_CONFIG`, keeping `developer_instructions`. The ACP elicitation mapping now reads codex-acp's form shape: the question from `title`, the header from `description`, and the `<id>_note` property (`_meta.codex.role: "user_note"`) as the free-text companion instead of a separate field.
