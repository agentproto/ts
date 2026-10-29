---
"@agentproto/identity": minor
---

Follow AIP-23 `work` narrowing (agentproto/agentproto#146). The frontmatter schema is regenerated from the vendored `IDENTITY.schema.json`: `work` is now the AIP-54 ref of the node's WORK.md, `ws://workspaces/@<owner>/<slug>/WORK.md`, the same form as the AIP-22 OFFICE `work` field. The old `ws://workspaces/<slug>` form was never spec-compliant, so manifests still using it must move to the AIP-54 ref. Same bump level as the matching `@agentproto/office` change (#2369).
