import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/billing
 * AIP-74: BILLING.md parser, defineBillingManifest, the payment path on the AIP-49 journal, SettlementProvider.
 */`,
  entry: {
    index: "src/index.ts",
    "manifest/index": "src/manifest/index.ts",
    "spend/index": "src/spend/index.ts",
    testing: "src/testing/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
