// Entry-based handle for the agentproto-run lane smoke test. `kind: "agent"`
// only reaches the compiler via an entry module (compile-workflow.ts) — it is
// not a declarative WORKFLOW.md-frontmatter kind — so this mirrors the
// with-entry fixture pattern: a literal object, no build step required.
export default {
  name: "Agentproto lane smoke test",
  id: "agentproto-lane-smoke",
  description: "One-step smoke test proving the agentproto-run composite action can boot a daemon, drive a WORKFLOW.md over MCP, and get a real agent reply back.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "reply-ok",
      kind: "agent",
      adapter: "claude-code",
      prompt: () => "Reply with exactly the word OK and nothing else. Do not use any tools.",
    },
  ],
}
