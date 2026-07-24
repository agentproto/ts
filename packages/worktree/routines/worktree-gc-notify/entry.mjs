// Runtime source of truth for WORKFLOW.md's step graph. The frontmatter
// mirrors this (id + kind) for governance, per `reconcileEntry`; `format`'s
// `compute` is a real function, which is why this step can only be
// entry-based — there is no string expression language for it in the
// declarative manifest.
export default {
  name: "Worktree GC + notify",
  id: "worktree-gc-notify",
  description:
    "Garbage-collect merged/fresh+clean worktrees, then report the outcome to Telegram via hosted agentpush.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "gc",
      kind: "tool",
      tool: "worktree_gc",
      inputs: {
        apply: true,
        salvageDirty: false,
        repoRoot:
          "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts",
      },
    },
    {
      id: "format",
      kind: "transform",
      // Turns the `gc` step's structured result into the exact JSON body
      // hosted agentpush's `POST /tools/send_message` expects. The `$steps.*`
      // ref grammar can substitute `$steps.gc` whole into another step's
      // inputs, but can't serialize an object into a plain string a later
      // tool step's `stdin` can carry — that's what this step is for.
      compute: (b) => {
        const gc = b.steps.gc ?? {}
        const outcomes = Array.isArray(gc.outcomes) ? gc.outcomes : []
        const counts = {}
        for (const o of outcomes) counts[o.result] = (counts[o.result] || 0) + 1
        const reaped = outcomes
          .filter(o => o.result === "reclaimed")
          .map(o => o.branch || o.path.split("/").pop())
        const line =
          Object.entries(counts)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ") || "nothing to do"
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ")
        let text = `🧹 worktree-gc (${stamp} UTC) — ${line}`
        if (reaped.length) text += `\nreaped: ${reaped.join(", ")}`
        return JSON.stringify({
          to: { channel: "telegram", address: "6371794295" },
          content: { text },
        })
      },
    },
    {
      id: "notify",
      kind: "tool",
      tool: "command_execute",
      inputs: {
        command: "bash",
        args: [
          "-c",
          [
            "set -a",
            ". /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/envs/agentpush/.env.local 2>/dev/null || true",
            "set +a",
            'curl -s --max-time 30 -X POST -H "Authorization: Bearer ${AGENTPUSH_API_KEY:-}" -H "Content-Type: application/json" https://api.agentpush.io/tools/send_message --data-binary @-',
          ].join("\n"),
        ],
        stdin: "$steps.format",
      },
    },
  ],
}
