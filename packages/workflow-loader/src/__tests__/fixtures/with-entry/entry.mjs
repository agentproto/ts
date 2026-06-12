// Stands in for `export default defineWorkflow({...})` — the loader only
// requires the default export be a handle-shaped object (id + steps). Kept as a
// literal so the fixture imports with no build step.
export default {
  name: "Double then add",
  id: "double-add",
  description: "Double the input, then add ten.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    { id: "d", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
    { id: "a", kind: "tool", tool: "demo.add-ten", inputs: { n: "$steps.d.n" } },
  ],
}
