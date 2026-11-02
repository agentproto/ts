export const robust = defineHarness({
  bin: "npx",
  bin_args: ["-y", "robust-cli@2.3.4"],
  install: [
    {
      // Comments and reordering must not hide the install entry.
      method: "npm",
      // A comment sits between the method and the package.
      package: "robust-cli@2.3.4",
      global: true,
    },
  ],
  version_check: {
    cmd: "npm view robust-cli version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=2.3.0",
  }
})
