// Second step diverges from the manifest (id 'x' / kind 'map' vs declared
// 'a' / kind 'tool') — reconciliation must reject this.
export default {
  name: "Mismatched",
  id: "mismatched",
  description: "Entry graph disagrees with the manifest.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    { id: "d", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
    { id: "x", kind: "map", over: "$steps.d.items", steps: [] },
  ],
}
