---
"@agentproto/wallet": minor
---

AIP-49: add a generic `qualify` partition-policy rule. `{ kind: "qualify", key, allow }` makes a lot spendable only when the spend context's caller-asserted `qualifiers[key]` is one of `allow` (`"*"` = any value, qualifier still required). It is fail-closed on a spend (a missing qualifier is ineligible), neutral on a pure balance read, never changes the quantity, and ANDs with `spendOn`/`expire`. `PolicyContext` gains optional `qualifiers`, and `spendableLotUnderPolicy` / `spendableBalanceUnderPolicy` accept an optional trailing `qualifiers` argument. The rule is accepted by `defineAsset`'s schema and vendored `ASSET.schema.json`.
