// Entry-based handle for the ADAPTER HARNESS bake-off. Like the lane smoke
// entry, `kind: "agent"` only reaches the compiler via an entry module
// (compile-workflow.ts) — it is not a declarative WORKFLOW.md-frontmatter kind.
//
// Unlike the smoke entry (which hard-codes adapter: "claude-code"), this one
// reads the adapter slug from the run INPUT ($input.adapter) so a single
// workflow file can drive EVERY adapter in the harness matrix — the caller
// passes `workflow-input: {"adapter":"<slug>"}`. The prompt is provider-
// agnostic and tiny: one turn, reply with a fixed token, no tools. Whether a
// given adapter/auth/model combo actually produces that assistant output
// headless is exactly what the bake-off measures.
export default {
  name: "Adapter harness bake-off smoke",
  id: "adapter-harness-smoke",
  description:
    "One-step, adapter-agnostic smoke turn for the adapter harness bake-off. " +
    "Spawns the adapter named in $input.adapter and asks it to reply with " +
    "exactly `HARNESS OK` — proof (or not) that this adapter/auth/model combo " +
    "produces assistant output headless.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "reply-ok",
      kind: "agent",
      // Adapter slug comes from the run input so one file serves the whole
      // matrix. Fall back to claude-code if the caller omits it (keeps the
      // file runnable by hand).
      adapter: (b) => {
        const a = b?.input?.adapter
        return typeof a === "string" && a.length > 0 ? a : "claude-code"
      },
      prompt: () => "Reply with exactly HARNESS OK and nothing else. Do not use any tools.",
    },
  ],
}
