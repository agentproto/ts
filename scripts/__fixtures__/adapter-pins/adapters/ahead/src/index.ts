export const ahead = defineHarness({
  bin: "npx",
  bin_args: ["-y", "ahead-cli@9.9.9"],
  install: [{ method: "npm", package: "ahead-cli@9.9.9", global: true }],
  version_check: {
    cmd: "npm view ahead-cli version",
    range: "=9.9.9",
  },
})
