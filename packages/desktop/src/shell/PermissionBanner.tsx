// Permission banner — polls surface pending ACP permission requests for the
// selected session. Each option is answered via POST /permissions/:id with the
// optionId and a decision inferred from the option's kind. ACP option kinds are
// allow_once / allow_always / reject_once / reject_always, so reject_* → deny and
// everything else → approve (matching the VS Code client's approval semantics).

import { respondPermission } from "../data/daemon"
import type { PendingPermission } from "../data/types"

interface PermissionBannerProps {
  permissions: PendingPermission[]
  onResponded: () => void
  daemonUrl?: string
}

function decisionForOption(kind: string | undefined): "approve" | "deny" {
  if (typeof kind === "string" && kind.startsWith("reject_")) return "deny"
  return "approve"
}

export function PermissionBanner({ permissions, onResponded, daemonUrl }: PermissionBannerProps) {
  const respond = async (permission: PendingPermission, optionId: string, kind?: string) => {
    try {
      await respondPermission(permission.id, { decision: decisionForOption(kind), optionId }, daemonUrl)
      onResponded()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("respondPermission failed:", e)
    }
  }

  if (permissions.length === 0) return null

  return (
    <div className="perm-banner">
      {permissions.map((perm) => (
        <div key={perm.id} className="perm-card">
          <div className="perm-meta">
            {perm.toolName ? <span className="perm-tool">{perm.toolName}</span> : null}
            <span className="perm-when">{perm.requestedAt}</span>
          </div>
          <div className="perm-text">{perm.text}</div>
          <div className="perm-options">
            {perm.options.map((opt) => (
              <button
                key={opt.optionId}
                className="btn ghost xs"
                onClick={() => void respond(perm, opt.optionId, opt.kind)}
              >
                {opt.name || opt.optionId}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
