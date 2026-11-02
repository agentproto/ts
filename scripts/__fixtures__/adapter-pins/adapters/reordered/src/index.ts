export const reordered = defineHarness({
  install: [
    {
      package: "reordered-cli",
      // The method key is deliberately after package with an inline comment.
      method: "npm",
      global: true,
    },
  ],
  version_check: {
    range: "=3.4.5",
    cmd: "npm view reordered-cli version",
  }
})
