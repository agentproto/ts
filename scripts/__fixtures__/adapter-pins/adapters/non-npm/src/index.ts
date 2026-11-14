export const nonNpm = defineHarness({
  bin: "grok",
  bin_args: ["agent", "stdio"],
  install: [{ method: "curl", url: "https://example.com/install.sh" }],
  version_check: {
    cmd: "grok --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.0.0",
  },
})
