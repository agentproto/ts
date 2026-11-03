---
"@agentproto/acp": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Structured harness questions (AIP-45 multi-field questions). With permission hold on, the ACP client advertises `elicitation.form` and turns a form `elicitation/create` (claude-code's AskUserQuestion: single choice, multiple choice, "Other" free text, several questions at once) into an `agent-prompt` with `request: "question"` and `question.fields`, parked like a permission. `respondPermission(id, { answers })` sends the answers back as the elicitation content. The runtime exposes the fields on `awaitingQuestion` (`requestId`, `fields`), and `permissions_respond`, `POST /permissions/:id` and the new `agentproto permissions answer` accept `answers`. `@agentclientprotocol/sdk` moves to 1.x in `@agentproto/acp`: 0.21.1 stripped the `_meta` and option descriptions the form relies on.
