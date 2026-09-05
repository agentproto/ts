---
"@agentproto/workflow-runtime": patch
"@agentproto/workflow": patch
---

Gate steps: resolve run-time refs in `cwd` and inside `args` strings. A gate's `cwd` and each `args[]` element now accept a LEADING `$input|$item|$steps.<id>|$index` ref token (AIP-16 prefix grammar) plus trailing literal text — e.g. `cwd: $input.bookDir`, `args: ["$input.bookDir/knowledge"]` — instead of only a bare whole-string ref for args (`$$` still escapes a literal `$`; an unresolvable ref throws naming the step and field). The resolved `cwd` is made absolute: an absolute value stays as-is, a relative one (incl. `.`) resolves against the workflow run's own cwd instead of the daemon process cwd. The string-ref resolver is factored into one shared implementation (`ref-string.ts`) shared with `harness.knowledge[]` selector strings.
