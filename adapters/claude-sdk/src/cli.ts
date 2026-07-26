#!/usr/bin/env node
/**
 * Standalone CLI for the first-party Claude Agent SDK adapter.
 *
 *   agentproto-claude-sdk acp [--model <id>] [--base-url <url>] \
 *     [--auth-token <token>] [--thinking]
 *
 * `acp` boots the ACP server over stdio — this is both what the agentproto
 * daemon spawns (as the `claude-sdk` arm) and what a user runs directly to
 * drive Claude Code's headless harness from any ACP-speaking host. I/O stays
 * 100% Anthropic-native.
 */

import { runAcpOverStdio } from "./run.js"
import type { ClaudeSdkConfig } from "./options.js"
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"

interface ParsedArgs {
  cmd?: string
  model?: string
  baseUrl?: string
  authToken?: string
  thinking?: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest = argv.slice(2)
  const out: ParsedArgs = { cmd: rest[0] }
  for (let i = 1; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--model") out.model = rest[++i]
    else if (arg === "--base-url") out.baseUrl = rest[++i]
    else if (arg === "--auth-token") out.authToken = rest[++i]
    else if (arg === "--thinking") out.thinking = true
  }
  return out
}

const USAGE =
  "usage: agentproto-claude-sdk acp [--model <claude-model>] " +
  "[--base-url <url>] [--auth-token <token>] [--thinking]\n"

/** Recognised permission-mode overrides (env `CLAUDE_SDK_PERMISSION_MODE`). */
const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]

function permissionModeFromEnv(
  raw: string | undefined,
): PermissionMode | undefined {
  return PERMISSION_MODES.find((mode) => mode === raw)
}

/** Parse the idle-stall watchdog override. A non-negative integer (ms); `0`
 *  disables the watchdog. Anything else (unset, negative, non-numeric) → the
 *  adapter default. */
function idleTimeoutMsFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const ms = Number.parseInt(raw, 10)
  return Number.isInteger(ms) && ms >= 0 ? ms : undefined
}

function main(): void {
  const { cmd, model, baseUrl, authToken, thinking } = parseArgs(process.argv)
  if (cmd !== "acp") {
    process.stderr.write(USAGE)
    process.exit(cmd ? 1 : 0)
  }
  const config: ClaudeSdkConfig = {
    model: model ?? process.env.CLAUDE_SDK_MODEL,
    baseUrl: baseUrl ?? process.env.ANTHROPIC_BASE_URL,
    // The daemon injects the manifest `auth_token` option as ANTHROPIC_AUTH_TOKEN
    // (env template); the flag is the standalone equivalent. Never logged.
    authToken: authToken ?? process.env.ANTHROPIC_AUTH_TOKEN,
    // `--thinking` (manifest bin_args_append_when_true) → options.thinking.
    ...(thinking ? { thinking: true } : {}),
    // Tools are confined to the dir the daemon spawned us in.
    cwd: process.cwd(),
    ...(permissionModeFromEnv(process.env.CLAUDE_SDK_PERMISSION_MODE)
      ? { permissionMode: permissionModeFromEnv(process.env.CLAUDE_SDK_PERMISSION_MODE) }
      : {}),
    // Idle-stall watchdog override (ms); guards against a gateway whose stream
    // never terminates (e.g. Moonshot). Unset → the adapter default applies.
    ...(idleTimeoutMsFromEnv(process.env.CLAUDE_SDK_IDLE_TIMEOUT_MS) !== undefined
      ? { idleTimeoutMs: idleTimeoutMsFromEnv(process.env.CLAUDE_SDK_IDLE_TIMEOUT_MS) }
      : {}),
    // Extended watchdog while tool calls are pending. Prevents the generation
    // watchdog from aborting a healthy turn during long tool execution.
    ...(idleTimeoutMsFromEnv(process.env.CLAUDE_SDK_TOOL_IDLE_TIMEOUT_MS) !== undefined
      ? { toolIdleTimeoutMs: idleTimeoutMsFromEnv(process.env.CLAUDE_SDK_TOOL_IDLE_TIMEOUT_MS) }
      : {}),
  }
  // The connection keeps the process alive (it holds stdin open); no explicit
  // wait loop needed.
  runAcpOverStdio(config)
}

main()
