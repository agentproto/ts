// The main pane's lower chrome: the subagents strip (orchestrator children) and
// the "Working…" row. Both are session-level, driven by the descriptor + the
// count of child sessions the rail already knows about.

import type { SessionDescriptor } from "../data/types"

export function SubagentStrip({ total, running }: { total: number; running: number }) {
  if (total === 0) return null
  return (
    <div className="subbar">
      <span className="chip">▾ {total} subagents</span>
      {running > 0 ? (
        <span className="chip">
          <span className="run" />
          {running} running
        </span>
      ) : null}
    </div>
  )
}

function formatTokens(n: number | undefined): string | null {
  if (typeof n !== "number" || n <= 0) return null
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function WorkingRow({ session }: { session: SessionDescriptor }) {
  if (!session.busy) return null
  const tokens = formatTokens(session.tokensIn)
  const waiting =
    session.blockedOn === "subagent"
      ? "waiting on subagent"
      : session.blockedOn === "command"
        ? "waiting on command"
        : null
  return (
    <div className="working">
      <span className="spin" />
      Working…
      {waiting ? <> · {waiting}</> : null}
      {tokens ? (
        <>
          {" · "}
          <b>{tokens} tokens</b>
        </>
      ) : null}
    </div>
  )
}
