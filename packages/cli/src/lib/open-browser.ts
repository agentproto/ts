/**
 * Open a URL in the user's default browser, with the same platform opener
 * `agentproto setup` inlines (`lib/setup-prompts.ts`, `commands/setup.ts`).
 * Shared by verbs such as `app store`. Fire-and-forget: the browser is
 * spawned detached and failures are swallowed (the caller prints the URL
 * anyway).
 */

import { spawn } from "node:child_process"
import { platform } from "node:os"

export function openInBrowser(url: string): void {
  const os = platform()
  const opener = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open"
  const args = os === "win32" ? ["/c", "start", url] : [url]
  const child = spawn(opener, args, { stdio: "ignore", detached: true })
  child.once("error", () => {})
  child.unref()
}
