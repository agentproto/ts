# @agentproto/billing

## 0.1.0

### Minor Changes

- 8c6c692: Add `@agentproto/billing`: the BILLING.md parser and `defineBillingManifest`, the payment path on the AIP-49 wallet journal (one-time and subscription includes, drops, rollover, reclaim), the `SettlementProvider` contract, the provider registry, and the `BILL-*` conformance cases. No payment provider ships in this package.
- 692dd3b: Publish `@agentproto/billing` and `@agentproto/voice-assemblyai` to npm at 0.1.0: drop `"private": true` and add the standard `publishConfig.access: "public"` that every published `@agentproto/*` package carries. (`@agentproto/voice` was already made publishable in #2806.) Both ship their built `dist/` (`files: dist, README.md, LICENSE`), and their workspace dependencies (`@agentproto/provider-kit`, `@agentproto/doctype`, `@agentproto/product`, `@agentproto/wallet`) are already on npm, so `workspace:*` resolves at publish. First release for the two names; changesets bump `0.0.0` → `0.1.0` (minor).

### Patch Changes

- 9141b07: Replace the `AIP-BILLING` placeholder with the real number `AIP-74` in the package docs, comments and fixtures, and re-sync the fixture schema with the vendored AIP-74 BILLING schema.
- a1eabc8: `canPay` now counts the headroom of a lot minted with a `floor` (a bounded short position, or `null` for an unbounded one), the same bound the journal enforces on commit. Before, it summed `remaining` only, so an account the journal would let spend down to its floor read as unable to pay, and a postpaid-style lot at zero could never pass the affordability check.
- 5b792bc: Remove private product and repository names from comments, docs, examples and tests.

  `@agentproto/auth` no longer ships a vendor provider: the `acmeAuthProvider`-style builtin export is removed and `BUILTIN_AUTH_PROVIDERS` is empty, so the registry starts empty. A host declares its own provider with `parseAuthProviderManifest` (or `defineAuthProvider`) and `registerAuthProvider`, which already existed. Breaking for code that imported the old export or looked the old id up without registering it.

  `@agentproto/role-catalog`: the legacy role map export is now `LEGACY_OPERATOR_ROLE_MAP`.

  `@agentproto/apps` (session-steward): new `extraClosableOrigins` input appended to the closable origin list in force. The generic default roots are `orchestrator` and `orchestrator:*`; a host that stamps its own root label adds it with `extraClosableOrigins`.

  The private Replicate fine-tune entry is dropped from the model catalog.

- Updated dependencies [765660d]
- Updated dependencies [1741e68]
- Updated dependencies [5b792bc]
- Updated dependencies [89258dd]
  - @agentproto/provider-kit@0.7.0
  - @agentproto/wallet@0.3.1
  - @agentproto/doctype@0.2.0
  - @agentproto/product@1.0.5
