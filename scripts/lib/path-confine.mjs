#!/usr/bin/env node
/**
 * PreToolUse path confinement for unattended Claude Agent SDK runs.
 *
 * `tools`/`allowedTools` only bound WHICH tools exist, not where they can
 * read/write — Read/Grep/Glob/Edit all accept absolute paths and are not
 * sandboxed to `cwd` by the SDK (verified live: an unconfined run read files
 * outside its repo, including a developer's own Claude Code memory
 * directory). `canUseTool` isn't the right gate either — verified live it's
 * only invoked for operations the CLI classifies as "dangerous"
 * (Edit/Write-like); Read/Grep/Glob sail through without ever calling it.
 * The SDK's own type docs for `SDKPermissionDenial` corroborate this
 * independently: "PreToolUse hook denies bypass canUseTool and are not
 * covered here." `PreToolUse` fires for every tool call unconditionally, so
 * it's the actual enforcement point.
 *
 * Pure/root-parameterized so it's testable without spawning the SDK or
 * depending on process cwd.
 */

import { resolve } from 'node:path'

export function resolvePathArg(root, toolName, input) {
  const raw = toolName === 'Edit' ? input.file_path : (input.path ?? input.file_path)
  return raw ? resolve(root, raw) : root
}

export function makeConfineToRepoRoot(root) {
  return async function confineToRepoRoot(input) {
    const resolved = resolvePathArg(root, input.tool_name, input.tool_input ?? {})
    if (resolved !== root && !resolved.startsWith(root + '/')) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Path escapes the repo root (${root}): ${resolved}`,
        },
      }
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
  }
}
