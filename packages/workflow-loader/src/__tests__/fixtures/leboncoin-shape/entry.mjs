// A RuntimeWorkflow-shaped entry (id + steps with procedural callbacks). The
// `transform` step holds arbitrary compute the declarative grammar can't carry
// — exactly why a workflow like this needs an entry rather than a pure
// manifest. Stub callbacks here; the real catalogue entry threads live tools.
export default {
  id: "leboncoin-houses",
  description: "search → commute → filter → report → deliver",
  steps: [
    { id: "search", kind: "tool", tool: "marketplace.search" },
    { id: "routes", kind: "map", over: () => [], body: () => ({}) },
    { id: "items", kind: "transform", compute: () => [] },
    { id: "report", kind: "tool", tool: "report.render" },
    { id: "sent", kind: "tool", tool: "messaging.send" },
  ],
  output: () => ({}),
}
