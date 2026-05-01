# @agentproto/governance

`agentgovernance/v1` — the universal contractual approval framework, published
as the open standard at [governance.sh](https://agentproto.sh/docs/gov-1).

> ⚠️ **Alpha (v0.1).** Spec stabilizing. APIs may change pre-1.0.

## Trust boundary (read this first)

`v0.1` ships an **honest internal building block**, not a fully-credible
contractual-approval product. Three pillars distinguish a credible standard from
this alpha; v0.1 has the first only:

| Pillar                                                                                                | v0.1                                                                                                                                                | Provided by                                                                            |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Bytes integrity** — "this artifact has not changed since signing"                                   | ✅ SHA-256 of artifact bytes recorded in `signature.json`; runtime always re-hashes from disk                                                       | `@agentproto/governance-engine`                                                         |
| **Identity authenticity** — "the signer was actually who the file says"                               | ❌ The `signer` field is a declarative string. Anyone with FS write access can author a `signature.json` claiming any signer.                       | Cryptographic JWS over the signature payload, bound to a per-identity key. Roadmap M4. |
| **History integrity vs. workspace owner** — "the workspace owner cannot rewrite the chain undetected" | ❌ The hash chain is verifiable by anyone who has the file, but the workspace owner can rewrite the file and re-chain. No external witness in v0.1. | OpenTimestamps / RFC 3161 / on-chain anchor sink. Roadmap M5.                          |

**Use v0.1 in trusted contexts only**: an internal workspace where everyone with
FS write is already inside your trust boundary, and you want a structured record
of approvals that's portable, type-checkable, and machine-verifiable (within
that trust boundary). Do **not** use v0.1 where any of the following is true:

- The workspace owner is one of the parties whose signature you need to trust.
- Counterparties outside your trust boundary author `signature.json` files.
- A regulator, court, or external auditor will be asked to rely on the chain.

The roadmap to close all three pillars (cryptographic identity in M4, external
anchoring in M5, RFC 8785 / cross-language conformance in M6) is published in
[the agentproto spec series](https://agentik.net/docs/aip-7). v1.0 of the
package will not ship until those three are in place.

## What this is

A small, vendor-neutral, filesystem-first standard for **recording approvals as
signatures, appending tamper-evident audit logs, and declaring autonomy
policies** — usable by any AI agent system that needs auditable decisions.

Three doctypes:

| Doctype           | File                                                   | Purpose                                                                                 |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `signature.json`  | `<artifact>/signatures/<signer>-<date>.signature.json` | Universal approval primitive (typed_name, agent_confirm, click_through, esign_external) |
| `audit-log.jsonl` | `<scope>/audit/audit-log.jsonl`                        | Append-only, hash-chained event log                                                     |
| `POLICY.md`       | `<scope>/policies/<slug>/POLICY.md`                    | Declarative autonomy rule (caps, thresholds, requiredSignatures-when-exceeded)          |

The full spec is in [`AGENTGOVERNANCE.md`](./AGENTGOVERNANCE.md).

## Why a peer standard

Governance doctypes are **domain-agnostic**: `signature.json`,
`audit-log.jsonl`, `POLICY.md` don't reference services, engagements, or
counterparties. Any workflow that needs an auditable approval — clinician
overrides, approve-to-publish flows, board votes, AI-agent actions — uses the
same files.

## Why filesystem

A client receiving a workspace folder can verify every signature + the entire
audit chain **without our infrastructure** using the published
[hash-chain protocol](./src/spec/hash-chain/protocol.md). Third-party verifiers
can be implemented in any language.

## Install

```bash
npm install @agentproto/governance
```

## Subpath exports

```ts
import {
  signatureSchema,
  auditEventSchema,
  policySchema,
} from "@agentproto/governance/doctypes"
import {
  computeChainSignature,
  verifyChain,
} from "@agentproto/governance/hash-chain"
import {
  validateSignature,
  validateAuditEvent,
  validatePolicy,
} from "@agentproto/governance/validators"
import {
  recordAuditEvent,
  signArtifact,
  listPendingSignatures,
} from "@agentproto/governance/runtime"
```

## Vendor neutrality

This package depends only on `zod`, `gray-matter`, `yaml`, and Node's built-in
`crypto`. There are **zero imports** from Mastra, LangChain, Temporal, or any
other workflow runtime. Adapters live in separate packages:

- `@agentproto/governance-mastra` — Mastra suspend/resume hooks
- (future) `@agentproto/governance-langchain`, `@agentproto/governance-temporal`,
  etc.

## Status

This is the **canonical implementation** of `agentgovernance/v1`. The spec is
open; alternative implementations are welcome at
[governance.sh](https://agentproto.sh/docs/gov-1).

## License

MIT
