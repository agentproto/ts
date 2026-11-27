---
"@agentproto/runtime": patch
---

MCP human gate: a question without `fields` is now carried as a form with one `answer` property (a `oneOf` of its choices, or a plain string when free text is allowed) and answered by `optionId` (free text as `feedback`), instead of the tool-permission form whose `approve` picked the first allow option. A `plan-approval` with a valid `planApproval` now resolves `approve` to `approveOptionId` and `deny` / `decline` to `rejectOptionId`, and offers no `scope`. Follows AIP-45 "MCP transport of a question".
