# @agentproto/agencies

`agentagencies/v1` — the operating-layer open standard for entities that
exercise agency, published at [agencies.sh](https://agentproto.sh/docs/agp-1).

> ⚠️ **Alpha.** Spec stabilizing. APIs may change pre-1.0.

## What this is

A vendor-neutral, filesystem-first standard for the **operating layer** of a
service business or any agentic system that acts on behalf of clients. Captures
the vocabulary of agency:

| Doctype            | File                                                          | Purpose                                                      |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `AGENCY.md`        | `<workspace-root>/AGENCY.md` (alongside COMPANY.md, optional) | Operational profile of the company when it acts as an agency |
| `OPERATIONS.md`    | `<external-pkg>/OPERATIONS.md`                                | Root file for external operations packages                   |
| `SERVICE.md`       | `services/<slug>/SERVICE.md`                                  | Catalog item — what the agency sells                         |
| `PROCEDURE.md`     | `procedures/<slug>/PROCEDURE.md`                              | Vendor-neutral playbook (steps, skills, autonomy)            |
| `PRICING-MODEL.md` | `pricing-models/<slug>/PRICING-MODEL.md`                      | Pricing rule (fixed/hourly/retainer/milestone/value/metered) |
| `COUNTERPARTY.md`  | `counterparties/<slug>/COUNTERPARTY.md`                       | External party (client)                                      |
| `ENGAGEMENT.md`    | `engagements/<slug>/ENGAGEMENT.md`                            | Commercial instance of a service for a counterparty          |
| `AGREEMENT.md`     | `engagements/<slug>/AGREEMENT.md`                             | Contract (uses governance.signature for signing)             |
| `DELIVERABLE.md`   | `engagements/<slug>/deliverables/<slug>/DELIVERABLE.md`       | Submitted work product                                       |
| `INVOICE.md`       | `engagements/<slug>/invoices/<inv-no>/INVOICE.md`             | Invoice                                                      |
| `ROUTINE.md`       | `routines/<slug>/ROUTINE.md`                                  | Schedule (cron) referencing a PROCEDURE.md                   |
| `CAPACITY.md`      | `capacity/<slug>/CAPACITY.md`                                 | Operator availability + load                                 |

The full spec is in [`AGENTAGENCIES.md`](./AGENTAGENCIES.md).

## Inheritance

`agentagencies/v1` extends two specs:

- [agentcompanies/v1](https://github.com/paperclipai/paperclip/blob/master/docs/companies/companies-spec.md)
  — org structure (COMPANY/TEAM/AGENTS/PROJECT/TASK/SKILL inherited verbatim)
- [agentgovernance/v1](https://governance.sh) — audit + signing (signature.json
  / audit-log.jsonl / POLICY.md used as-is)

A workspace using `agentagencies/v1` MUST validate as a valid
`agentcompanies/v1` package AND as a valid `agentgovernance/v1` package wherever
signatures/audit/policy doctypes appear.

## "Agency" is a deliberate double-meaning

- **Business**: service businesses, agencies, consultancies, freelancers —
  anyone who operates _for_ clients.
- **Philosophical / AI**: the capacity of a system to act with intention,
  autonomy, decision-making.

Both readings converge on entities that act. The doctypes encode the vocabulary
in either reading.

## Install

```bash
npm install @agentproto/agencies
```

## Subpath exports

```ts
import {
  agencySchema,
  engagementSchema,
  agreementSchema /* ... */,
} from "@agentproto/agencies/doctypes"
import {
  validateAgreement,
  validateEngagement /* ... */,
} from "@agentproto/agencies/validators"
import { resolveOperationsRef } from "@agentproto/agencies/composition"
import {} from /* canvakit template ids */ "@agentproto/agencies/renderers"
import {} from /* engagement orchestrator, etc. */ "@agentproto/agencies/runtime"
```

## Vendor neutrality

This package depends on `zod`, `gray-matter`, `yaml`, `@agentproto/governance`
(peer spec), and Node's built-in `crypto`/`fs`/`path`. Zero imports from Mastra,
LangChain, Temporal, or any orchestration runtime. Adapters live in separate
packages:

- `@agentproto/agencies-mastra` — Mastra adapter (codegen PROCEDURE.md → workflow.ts,
  suspend/resume hooks)
- (future) `@agencies/langchain`, `@agencies/temporal`, etc.

## License

MIT
