export const final = defineHarness({
  install: [{ method: "npm", package: "final-cli", global: true }],
  version_check: {
    range: ">=5.6.7 <6",
    // version_check is the final property and has no trailing comma.
    cmd: ["npm", "view", "final-cli", "version"],
  }
})
