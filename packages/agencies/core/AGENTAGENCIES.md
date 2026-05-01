# agentagencies/v1

**Status:** alpha (1.0.0-alpha) · **Domain:** agencies.sh · **License:** MIT
**Reference implementation:**
[@agentproto/agencies](https://npmjs.com/package/@agentproto/agencies) **Repository:**
https://github.com/agentproto/ts

> Brief overview here. Full canonical spec is shipped at
> [`src/spec/agentagencies-v1.md`](./src/spec/agentagencies-v1.md) (TBD — Phase
> 1 has the README + per-doctype zod as the source of truth).

## Quick reference

`agentagencies/v1` is an **open file-format standard** for the operating layer
of agencies. It extends:

- `agentcompanies/v1` (companies.sh) — org structure
- `agentgovernance/v1` (governance.sh) — contractual approval framework

Operations doctypes added by agentagencies/v1:

| File               | Purpose                                    |
| ------------------ | ------------------------------------------ |
| `AGENCY.md`        | Operational profile (alongside COMPANY.md) |
| `OPERATIONS.md`    | Root file for external operations packages |
| `SERVICE.md`       | Catalog item                               |
| `PROCEDURE.md`     | Vendor-neutral playbook                    |
| `PRICING-MODEL.md` | Pricing rule                               |
| `COUNTERPARTY.md`  | External client                            |
| `ENGAGEMENT.md`    | Commercial instance                        |
| `AGREEMENT.md`     | Contract                                   |
| `DELIVERABLE.md`   | Work product                               |
| `INVOICE.md`       | Bill                                       |
| `ROUTINE.md`       | Schedule                                   |
| `CAPACITY.md`      | Operator availability                      |

See [README.md](./README.md) for paths + per-doctype shape; per-doctype zod
schemas at `src/spec/doctypes/` are the alpha source of truth pending the
canonical markdown spec.
