export const exact = defineHarness({
  bin: "npx",
  bin_args: ["-y", "@scope/wrapper@1.2.3"],
  install: [
    {
      method: "npm",
      package: "@scope/wrapper@1.2.3",
      global: true,
    },
  ],
  version_check: {
    cmd: "npm ls -g @scope/wrapper --depth=0",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: "=1.2.3",
  },
})
