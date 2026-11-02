export const commented = defineHarness({
  // install: [{ method: "npm", package: "old-cli@0.1.0" }],
  install: [{ method: "npm", package: "commented-cli@4.5.6", global: true }],
  version_check: { cmd: "npm view commented-cli version", range: "=4.5.6" },
})
