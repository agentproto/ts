export const ranged = defineHarness({
  bin: "ranged-cli",
  install: [{ method: "npm", package: "ranged-cli", global: true }],
  version_check: {
    cmd: "npm view ranged-cli version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.4.0 <2",
  },
})
