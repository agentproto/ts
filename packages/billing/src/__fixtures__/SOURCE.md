# Fixtures

`BILLING.schema.json` is a byte copy of `specs/resources/aip-74/draft/BILLING.schema.json`,
the AIP-74 schema vendored from the canonical registry at commit
`9e7b4bd0818c7a1b8897ea93c2cf47616a4b6780` (the pin in `specs/canonical.lock.json`).
`examples/*.BILLING.md` are test data copied from the AIP-74 draft
(pull request agentproto/agentproto#170, branch `aip-74-billing`, commit
`e449783d3ef80a3b80f33c84ddc29965f83b8508`), neutralized (no private product names or internal file references); they are not byte copies of the canonical examples.

The schema is a draft: when the draft moves, these files move with it, in the same
change as the parser. When `specs/canonical.lock.json` is bumped, re-copy the schema
from `specs/resources/aip-74/draft/`.

Update (usage section): `BILLING.schema.json` carries the `usage` field added by
agentproto/agentproto#181 (companion of #178). It is a byte copy of
`specs/resources/aip-74/draft/BILLING.schema.json` at agentproto/agentproto commit
`516205e3167c08b41aed646bda3957480ea30395` (main, after #181 merged).
