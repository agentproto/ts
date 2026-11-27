# Fixtures

`BILLING.schema.json` is the AIP-74 schema, `specs/resources/aip-74/draft/BILLING.schema.json`
from the canonical registry, taken at agentproto/agentproto commit
`516205e3167c08b41aed646bda3957480ea30395` (main, after agentproto/agentproto#181 added the
`usage` field, companion of #178). That commit is the single base of this file.

On top of that base it carries two optional offer fields ahead of the canonical draft:
`discounts` (`allow` | `refuse`) and `subscription.trial` (an ISO 8601 duration). They are
mirrored in `schema.ts`. Apart from these two fields the file is a byte copy of the base.
Once the draft carries them, re-copy the whole file from `specs/resources/aip-74/draft/`
and update the commit above: it is then a byte copy again.

The base is not the repo-wide pin in `specs/canonical.lock.json`, which may be older: this
fixture follows the AIP-74 draft as the parser needs it, in the same change as the parser.

`examples/*.BILLING.md` are test data copied from the AIP-74 draft
(pull request agentproto/agentproto#170, branch `aip-74-billing`, commit
`e449783d3ef80a3b80f33c84ddc29965f83b8508`), neutralized (no private product names or internal file references); they are not byte copies of the canonical examples.
