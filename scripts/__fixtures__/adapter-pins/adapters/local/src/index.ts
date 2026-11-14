export const local = defineHarness({
  bin: "node",
  bin_args: [cliEntry, "acp"],
  install: [{ method: "npm", package: "@agentproto/adapter-local", global: true }],
  version_check: {
    cmd: "node --version",
    parse: "v(\\d+\\.\\d+\\.\\d+)",
    range: ">=20.9.0",
  },
})
