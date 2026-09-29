/**
 * Governance wiring for the approvals workspace — a
 * `@agentproto/governance-engine` `GovernanceConfig` rooted at
 * `~/.agentproto/approvals/` (or a test's tmp home). Approve → `signArtifact`
 * on `<id>/payload.json` (AIP-7 `signerKind: "user"`, `method:
 * "click_through"`); approve and deny both → `recordAuditEvent` under
 * `audit/audit-log.jsonl`, hash-chained. Every tool the underlying spec
 * exposes beyond these two calls (`sign_as_agent`, `request_signatures`,
 * the doctype's own MCP tools) is deliberately unused here — see the lane
 * spec's "agents never decide" rule.
 */

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { GovernanceConfig } from "@agentproto/governance-engine"

interface ApprovalsSecrets {
  genesisSeed: string
  hmacSecret: string
}

function secretsPath(homeDir: string): string {
  return join(homeDir, "_secrets.json")
}

/** Load the workspace's genesis seed + HMAC secret, generating and
 *  persisting them (mode 0600) on first use. Stable across restarts so the
 *  audit chain and every signature it anchors stay verifiable. */
function loadOrCreateSecrets(homeDir: string): ApprovalsSecrets {
  const path = secretsPath(homeDir)
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ApprovalsSecrets>
      if (
        typeof parsed.genesisSeed === "string" &&
        /^[a-f0-9]{64}$/.test(parsed.genesisSeed) &&
        typeof parsed.hmacSecret === "string" &&
        parsed.hmacSecret.length > 0
      ) {
        return { genesisSeed: parsed.genesisSeed, hmacSecret: parsed.hmacSecret }
      }
    } catch {
      // Fall through to regenerate — a corrupted secrets file must not
      // wedge the daemon; a fresh chain simply starts from a new genesis.
    }
  }
  const secrets: ApprovalsSecrets = {
    genesisSeed: randomBytes(32).toString("hex"),
    hmacSecret: randomBytes(32).toString("hex"),
  }
  mkdirSync(homeDir, { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(secrets, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  renameSync(tmp, path)
  return secrets
}

/** Build (or resume) the governance workspace for `homeDir`. Exported
 *  standalone — not just via the engine — so tests can independently
 *  resolve the same config to verify the audit chain / signature hashes
 *  the engine produced. */
export function resolveApprovalsGovernanceConfig(homeDir: string): GovernanceConfig {
  const { genesisSeed, hmacSecret } = loadOrCreateSecrets(homeDir)
  return { workspaceRoot: homeDir, genesisSeed, hmacSecret }
}
