---
"@agentproto/app-kit": minor
---

Add AIP-53 `setup[]` — an ordered, idempotent post-install configuration pipeline carried by an app manifest. `types.ts` exports a discriminated `AppSetupStep` union (`cmd`, `prompt`, `oauth`, `external`, `choice`, `auth-profile`, `pairing`, `check`, plus vendor `x-*`) and the supporting `AppSetupWhen`, `AppSetupSkipIf`, `AppSetupPersist`, `AppSetupOption` and `AppSetupCheck` types; `manifest-fields.ts` validates each step's per-kind shape against the vendored `APP.schema.json`; `defineApp` applies conformance rule 10 purely (non-empty, unique ids, `when.step` names an earlier step, exactly one `persist` slot, `choice.default` among its options, no `persist.answer` on a `type: secret` prompt); `emit`/`loadAppHandle` carry it verbatim.
