# agentgovernance/v1

**Status:** alpha (1.0.0-alpha) · **Domain:** governance.sh · **License:** MIT
**Reference implementation:**
[@agentproto/governance](https://npmjs.com/package/@agentproto/governance)
**Repository:** https://github.com/agentproto/agentproto

---

## 1. Introduction

`agentgovernance/v1` is an **open file-format standard** for recording
approvals, audit logs, and autonomy policies as workspace files. It provides a
**vendor-neutral**, **filesystem-first**, **third-party-verifiable** primitive
for any system — human, agentic, or hybrid — that needs auditable decisions.

Three doctypes:

| Doctype       | File path                                                    | Purpose                                                     |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| `signature`   | `<artifact>/../signatures/<signer>-<isoDate>.signature.json` | Universal approval primitive (one signature event per file) |
| `audit-event` | `<scope>/audit/audit-log.jsonl` (one line per event)         | Append-only hash-chained event log                          |
| `policy`      | `<scope>/policies/<slug>/POLICY.md`                          | Declarative autonomy rule                                   |

A workspace receiving these files can validate every doctype + verify the audit
chain end-to-end **without our infrastructure** using the published
[hash-chain protocol](./src/spec/hash-chain/protocol.md). Third-party verifiers
can be implemented in any language.

### 1.1 Why this is its own standard

The doctypes are **domain-agnostic**: `signature.json`, `audit-log.jsonl`,
`POLICY.md` reference no business concepts (no services, no engagements, no
counterparties). They describe pure governance primitives. Any workflow that
needs auditable approvals — clinician overrides, approve-to-publish flows,
AI-agent action gates, board votes — adopts `agentgovernance/v1` directly.

`agentgovernance/v1` is a **peer standard** to `agentcompanies/v1`
(companies.sh) and is **extended by** `agentagencies/v1` (agencies.sh).

### 1.2 Conventions

All `agentgovernance/v1` files follow the conventions established by
[`agentcompanies/v1`](https://github.com/paperclipai/paperclip/blob/master/docs/companies/companies-spec.md):

- **Markdown canonical** with YAML frontmatter (for `POLICY.md`).
- **JSON canonical** for `signature.json` and `audit-log.jsonl` lines.
- **Slug-based references**, never database IDs.
- **`schema: agentgovernance/v1`** field on every doctype frontmatter / object.
- **Vendor-specific extensions** under `metadata.<vendor>.*`.
- **Git-native**: any git repository hosting these files is a valid governance
  package.

A workspace using `agentgovernance/v1` doctypes does not need to be an
`agentcompanies/v1` package — it can be any folder containing the doctypes.

---

## 2. Doctype: `signature`

A signature is the universal approval primitive. Every approval — of an
agreement, a deliverable, an invoice, a policy override, an agent-issued action
— is a signature on an artifact, recorded as a JSON file alongside the artifact
being signed.

### 2.1 File location

```
<artifact-parent-dir>/signatures/<signer-kind>-<signer-slug>-<YYYY-MM-DD>.signature.json
```

Example:

```
engagements/2026-acme-website-redesign/signatures/operator-jeremy-2026-04-15.signature.json
```

Multiple signatures by the same signer on the same artifact (e.g., re-issuance
after revocation) MUST use distinct timestamps. Append-only — files are not
deleted; revocation is a frontmatter mutation (`revokedAt`, `revokedReason`) or
a fresh file with `evidence` referencing the prior.

### 2.2 Schema

```typescript
{
  "schema": "agentgovernance/v1",
  "doctype": "signature",
  "signer": "<kind>:<slug>",          // canonical: "operator:jeremy", "counterparty:acme-corp", "agent:ai-paralegal"
  "signerKind": "operator" | "user" | "counterparty" | "agent" | "external",
  "signerEmail"?: string,
  "artifactPath": "engagements/2026-acme/AGREEMENT.md",  // workspace-relative
  "documentHash": "<64-char hex SHA-256 of artifact bytes>",
  "method": "typed_name" | "agent_confirm" | "click_through" | "esign_external",
  "evidence": <method-specific shape>,
  "signedAt": "2026-04-15T10:23:45.000Z",
  "revokedAt"?: string,
  "revokedReason"?: string,
  "metadata"?: { ... }
}
```

`evidence.kind` MUST equal `method` (enforced at validation time).

### 2.3 Signing methods

#### 2.3.1 `typed_name`

Human types name + nonce on a tokenized portal page. Captures IP + UA +
timestamp + nonce.

```json
{
  "evidence": {
    "kind": "typed_name",
    "signerName": "Jeremy Doe",
    "ipAddress": "192.0.2.1",
    "userAgent": "Mozilla/5.0 …",
    "nonce": "<one-shot URL token>",
    "signedUrlToken": "<optional>"
  }
}
```

#### 2.3.2 `agent_confirm`

Agent records explicit confirmation. Evidence carries `modelId` +
`promptContextHash` + optional reasoning summary + conversation turn id. Agents
MUST have the `governance.sign_as_agent` skill (or app-level equivalent) granted
by a `POLICY.md`.

```json
{
  "evidence": {
    "kind": "agent_confirm",
    "modelId": "claude-sonnet-4-6",
    "promptContextHash": "<64-char hex>",
    "reasoningSummary": "Cap policy satisfied; under threshold.",
    "conversationTurnId": "t_abc123",
    "authorizedByPolicy": "auto-approve-quotes-under-200eur"
  }
}
```

#### 2.3.3 `click_through`

Single-click confirmation from a signed URL. Lightweight; suitable for
low-stakes approvals.

```json
{
  "evidence": {
    "kind": "click_through",
    "ipAddress": "192.0.2.1",
    "userAgent": "Mozilla/5.0 …",
    "signedUrlToken": "<one-shot>"
  }
}
```

#### 2.3.4 `esign_external`

Wraps an external e-signature provider (DocuSeal, HelloSign, etc.). The signed
PDF MUST be archived alongside the agreement.

```json
{
  "evidence": {
    "kind": "esign_external",
    "provider": "docuseal",
    "externalRef": "<envelope-id>",
    "signedPdfRef": "engagements/2026-acme/AGREEMENT.signed.pdf"
  }
}
```

---

## 3. Doctype: `audit-event` (audit-log.jsonl)

Each line of `<scope>/audit/audit-log.jsonl` is one audit event, encoded as a
single JSON object on one line. Lines are linked by an HMAC-SHA256 chain.

### 3.1 Scope

The `<scope>` directory determines the chain's scope. Common scopes:

- `audit/audit-log.jsonl` — workspace / company-level events.
- `engagements/<slug>/audit/audit-log.jsonl` — engagement-scoped events
  (recommended for `agentagencies/v1`).
- Any other folder may host its own log — there is no global registry.

Each scope has its own chain, its own genesis seed, and its own anchor cadence.

### 3.2 Schema

```typescript
{
  "schema": "agentgovernance/v1",
  "doctype": "audit-event",
  "actorKind": "operator" | "user" | "counterparty" | "agent" | "system",
  "actorId": <slug | null>,                 // null for actorKind=system
  "entityType": "<known type or extension>",
  "entityId": "<workspace path or governance-internal id>",
  "action": "<entity>.<verb>",              // lowercase, e.g., "signature.created"
  "payload"?: { ... },                      // action-specific
  "prevSignature": "<64-char hex>",         // chain link
  "signature": "<64-char hex>",             // chain link
  "requestId"?: string,
  "traceId"?: string,
  "ipAddress"?: string,
  "userAgent"?: string,
  "createdAt": "<ISO-8601 UTC>",
  "metadata"?: { ... }
}
```

Implementations SHOULD use known `entityType` values (`signature`,
`audit-event`, `policy`, `approval`, plus any from `agentagencies/v1` or
`agentcompanies/v1` if those specs are in use). Implementations SHOULD NOT
introduce new types ad-hoc — vendor-specific events go under
`metadata.<vendor>.*`.

### 3.3 Hash-chain protocol

See [`src/spec/hash-chain/protocol.md`](./src/spec/hash-chain/protocol.md) for
the full specification with reference test vectors.

Summary:

```
signature_n = HMAC-SHA256(
  key  = secret_bytes,
  data = prev_signature_hex_utf8 ‖ canonical_bytes(row_n_minus_signature)
)
```

The first line uses the workspace genesis seed as `prev_signature`.

### 3.4 External anchors

Periodically (default: every 1000 lines), the latest `signature` is published to
an external sink (S3 with object-lock, transparency log, public Git). A
workspace cannot rewrite history without invalidating an external anchor.

---

## 4. Doctype: `policy` (POLICY.md)

A POLICY.md is a declarative autonomy rule with YAML frontmatter and a markdown
body. Frontmatter is used by the policy engine; body is human/agent-readable
narrative.

### 4.1 File location

```
<scope>/policies/<slug>/POLICY.md
```

### 4.2 Frontmatter schema

```yaml
schema: agentgovernance/v1
doctype: policy
slug: invoice-cap-500eur
name: Invoice cap 500 EUR
description:
  Operators may issue invoices ≤ 500 EUR autonomously; founder signature
  required above.
appliesTo:
  - actorKind: operator
    actionType: agency.issue_invoice
caps:
  - field: amount
    max: 500
    currency: EUR
threshold: single # auto | single | all_of | any_of | weighted_threshold
requiredWeight: 0 # required when threshold=weighted_threshold
requiredSignatures:
  - signer: operator:founder
    method: typed_name
    weight: 1 # only used by weighted_threshold
deadline: PT24H # ISO-8601 duration
escalation:
  leadTime: PT2H
  escalateTo: [operator:cofounder]
metadata:
  agency:
    appliesToServices: [emergency-callout, drain-cleaning]
```

### 4.3 Threshold semantics

| `threshold`          | Resume condition                                                     |
| -------------------- | -------------------------------------------------------------------- |
| `auto`               | Tool may proceed without signatures (action is logged but not gated) |
| `single` / `any_of`  | Any one signature from `requiredSignatures` suffices                 |
| `all_of`             | Every entry in `requiredSignatures` must sign                        |
| `weighted_threshold` | Sum of `weight` of collected signatures must reach `requiredWeight`  |

### 4.4 Wildcard signers

A `requiredSignatures` entry may use `*` as the slug to mean "any signer of this
kind":

```yaml
requiredSignatures:
  - signer: operator:*
    method: typed_name
```

This is satisfied by any operator's signature.

---

## 5. Contractual approval framework

The framework unifies what would otherwise be three concepts (signing legal
documents, approval gates, audit decisions) into one: **every approval is a
signature on an artifact**.

### 5.1 Standard flow

A tool that needs approval for an action:

1. **Drafts** the artifact representing the action (e.g., an `INVOICE.md` with
   `status: pending_approval`).
2. **Looks up** the matching `POLICY.md` (by `appliesTo.actorKind` +
   `appliesTo.actionType`).
3. **Sets** `requiredSignatures` on the artifact frontmatter from the policy.
4. **Suspends** (workflow primitive — runtime-specific; see adapter packages).
5. **Notifies** required signers (channel dispatcher — see
   `agentagencies/v1.channels` or app-level equivalent).

When a signer (human OR agent) signs:

1. The runtime writes a `signature.json` next to the artifact.
2. The runtime appends an `audit-event` to the relevant `audit-log.jsonl` (with
   `action: signature.created`).
3. The runtime checks if all `requiredSignatures` are now collected per the
   policy threshold.
4. If yes, the suspended workflow resumes; the originally-suspended tool
   finishes (artifact is finalized, side-effects fire).

### 5.2 Pending-signature index

Implementations SHOULD maintain a regeneratable index file
`<workspace>/_index/pending-signatures.json` keyed by signer:

```json
{
  "version": "1",
  "updatedAt": "2026-04-26T15:00:00.000Z",
  "bySigner": {
    "operator:founder": [
      {
        "artifactPath": "engagements/2026-acme/INVOICE.md",
        "deadline": "2026-05-15T17:00:00.000Z",
        "requestedAt": "2026-04-26T14:00:00.000Z",
        "method": "typed_name",
        "weight": 1
      }
    ]
  }
}
```

The index is **not authoritative** — it can be rebuilt at any time by walking
the workspace for artifacts with `requiredSignatures`. Its sole purpose is fast
operator-inbox queries.

---

## 6. Composition with other specs

`agentgovernance/v1` is independent. It can be adopted by any app:

```
my-app/
├── audit/audit-log.jsonl
├── policies/<slug>/POLICY.md
├── <some-artifact>.md
└── <some-artifact>.signatures/
    └── operator-jeremy-2026-04-15.signature.json
```

When composed with `agentcompanies/v1` (companies.sh):

- `actorKind: operator` corresponds to the org's `AGENTS.md` entries.
- Policies may reference operator slugs from the company package.

When composed with `agentagencies/v1` (agencies.sh):

- Engagement / agreement / deliverable / invoice artifacts use
  `agentgovernance/v1.signature.json` for signing.
- Per-engagement audit logs become the canonical record of the engagement.

A workspace using `agentagencies/v1` MUST validate as a valid
`agentgovernance/v1` workspace wherever `signature.json`, `audit-log.jsonl`, or
`POLICY.md` files appear (SHALL clause).

---

## 7. SHALL / SHOULD / MAY

- **SHALL** Every `signature.json` MUST have `evidence.kind === method` (or
  validators reject).
- **SHALL** Every `audit-log.jsonl` line MUST chain correctly per the hash-chain
  protocol — verifiers report the first mismatch.
- **SHALL** `documentHash` MUST be lowercase 64-character hex of SHA-256 over
  the artifact bytes at signing time.
- **SHALL** `signedAt` MUST be ISO-8601 with UTC timezone.
- **SHOULD** `audit-event.entityType` SHOULD use known values (no ad-hoc
  strings).
- **SHOULD** `policies/<slug>/` SHOULD contain only `POLICY.md` and supporting
  docs (no executable code).
- **MAY** Vendor-specific fields MAY appear under `metadata.<vendor>.*`.
- **MAY** Implementations MAY add fields to `payload`, `evidence`, `metadata`
  objects for forward compatibility — readers MUST ignore unknown fields.

---

## 8. Vendor extensions

Vendor-specific runtime data goes under `metadata.<vendor>.*`. Examples:

```yaml
# In a POLICY.md frontmatter
metadata:
  mastra:
    workflowId: "issue-invoice-with-cap"
  guilde:
    appliesToOperatorTeams: [billing, sales]
```

Adapter packages (`@agentproto/governance-mastra`, etc.) are the consumer-facing
API for vendor-specific orchestration. The core spec stays vendor-neutral.

---

## 9. Versioning

This document specifies `agentgovernance/v1`, version 1.0.0-alpha.

Future minor versions (1.x) MAY add fields and methods (with non-breaking
semantics). Major versions (2.x) MAY change the chain protocol or doctype
shapes. Workspaces MUST emit the same version per file; mixing versions in one
chain is forbidden.

When version 1.0 stabilizes, this spec moves to https://agentproto.sh/docs/gov-1/v1.

---

## 10. Reference implementation

[@agentproto/governance](https://npmjs.com/package/@agentproto/governance) is the
reference TypeScript implementation, MIT-licensed. It ships:

- Zod schemas for all doctypes (`./doctypes`)
- Validators (`./validators`)
- Hash-chain protocol — compute + verify (`./hash-chain`)
- Canvakit renderers + templates for signing-portal / signature-card /
  audit-timeline (`./renderers` after Phase 1)
- FS-only runtime helpers — `recordAuditEvent`, `signArtifact`,
  `listPendingSignatures` (`./runtime`)

Test corpus lives in `test/fixtures/` and includes hash-chain test vectors that
any implementation MUST reproduce byte-for-byte.

---

## 11. Compatibility test corpus (TBD — Phase 1)

A frozen set of test vectors (input artifact bytes + secret + genesis seed →
expected canonical bytes + expected signature) will be published with v1.0
stable. Any implementation passing these vectors is interoperable with the
reference.

For alpha, integration tests in `src/spec/hash-chain/{compute,verify}.test.ts`
and `src/runtime/runtime.e2e.test.ts` document the expected behavior.

---

## 12. Acknowledgments

This spec extends the conventions of
[agentcompanies/v1](https://github.com/paperclipai/paperclip/blob/master/docs/companies/companies-spec.md)
(paperclipai). Hash-chain construction draws on RFC 8785 (JCS), classic
Merkle/append-only log designs, and transparency log practice.
