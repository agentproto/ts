#!/usr/bin/env node
/**
 * Shared deterministic provenance footer builder for agentic deliveries the
 * runner stamps AFTER the box has done its work. The runner owns the footer —
 * never the model — so the `@agentproto-bot` marker is a reliable
 * native-vs-legacy discriminator and carries session provenance + cost that the
 * box can't know about itself.
 */

// Marker string used as the native-vs-legacy footer discriminator
export const MARKER = "@agentproto-bot"

export const fmtTokens = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return null
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export const buildFooter = ({ prov, authMode, runId, runUrl, sha, kind = "review" }) => {
  const parts = [`🤖 **${MARKER}** — ${kind}`]
  if (prov?.sessionId) {
    parts.push(`session \`${prov.sessionId}\`${prov.label ? ` (\`${prov.label}\`)` : ""}`)
  }
  // Engine label: "adapter / authMode" when an adapter ran; "legacy fallback
  // (authMode)" when no agent session exists at all (the API-key fallback path);
  // bare authMode only if a session ran without a resolved adapter slug.
  if (prov?.adapter) parts.push([prov.adapter, authMode].filter(Boolean).join(" / "))
  else if (!prov?.sessionId) parts.push(`legacy fallback${authMode ? ` (${authMode})` : ""}`)
  else if (authMode) parts.push(authMode)
  if (prov?.sandboxId) parts.push(`e2b \`${prov.sandboxId}\``)
  if (prov?.parentSessionId) parts.push(`supervisor \`${prov.parentSessionId}\``)
  const tin = fmtTokens(prov?.tokensIn)
  const tout = fmtTokens(prov?.tokensOut)
  if (tin || tout) parts.push(`${tin ?? "?"} in / ${tout ?? "?"} out`)
  if (typeof prov?.costUsd === "number") {
    parts.push(`$${prov.costUsd.toFixed(4)}${prov.source && prov.source !== "adapter" ? ` (${prov.source})` : ""}`)
  }
  if (runId) parts.push(`run [${runId}](${runUrl})`)
  if (sha) parts.push(`sha \`${sha.slice(0, 7)}\``)
  return `\n\n---\n<sub>${parts.join(" · ")}</sub>`
}
