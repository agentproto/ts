---
"@agentproto/workflow-runtime": minor
---

Extract shared AIP-16 ref-prefix resolution logic into a new `resolveRefPrefixed` function that resolves the leading ref token of a string and returns the resolved value plus the literal remainder. Refactor `knowledge.ts` to use this new function, reducing duplication and enabling broader reuse of prefix-style ref parsing.
