/**
 * PAT flow engine — reads an existing token from the Keychain or prompts for one.
 *
 * This is the "legacy-compatible" flow: the user has a personal API key
 * (`gld_*`, `sk-*`, …) and the CLI needs to store/retrieve it. No browser
 * open, no ceremony. Use `service-auth` for the seamless browser-approve path.
 */

import { createInterface } from "node:readline"
import type {
  FlowEngine,
  FlowRunOptions,
  FlowResult,
  AuthProviderHandle,
  DiscoveredEndpoints,
} from "../types.js"
import { KeychainStore } from "../store/keychain-store.js"
import { resolveStoreRefs, readStoreRefWithFallback } from "../store/resolve-ref.js"

/**
 * Read a secret from the terminal WITHOUT echoing it — the typed key must not
 * land on screen or in scrollback. On a TTY we drop to raw mode and render a `*`
 * mask per character. When stdin isn't a TTY (piped input, CI, tests) there's no
 * echo to suppress and no raw mode to enter, so we read a line normally.
 */
async function promptToken(label: string): Promise<string> {
  const input = process.stdin
  const out = process.stderr

  if (!input.isTTY) {
    return new Promise((resolve) => {
      const rl = createInterface({ input, output: out })
      out.write(`${label}: `)
      rl.question("", (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }

  return new Promise((resolve, reject) => {
    out.write(`${label}: `)
    const chars: string[] = []
    input.setRawMode(true)
    input.resume()
    input.setEncoding("utf8")

    const cleanup = () => {
      input.setRawMode(false)
      input.pause()
      input.removeListener("data", onData)
    }

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        switch (ch) {
          case "\r":
          case "\n":
            out.write("\n")
            cleanup()
            resolve(chars.join("").trim())
            return
          case "\u0003": // Ctrl-C
            out.write("\n")
            cleanup()
            reject(new Error("auth cancelled"))
            return
          case "\u0004": // Ctrl-D — treat as end-of-input
            out.write("\n")
            cleanup()
            resolve(chars.join("").trim())
            return
          case "\u007f": // Backspace / Delete
          case "\b":
            if (chars.length > 0) {
              chars.pop()
              out.write("\b \b")
            }
            break
          default:
            // Mask printable input; ignore stray control characters.
            if (ch >= " ") {
              chars.push(ch)
              out.write("*")
            }
        }
      }
    }

    input.on("data", onData)
  })
}

export const patFlowEngine: FlowEngine = {
  id: "pat",

  async run(
    provider: AuthProviderHandle,
    _discovered: DiscoveredEndpoints | null,
    opts: FlowRunOptions,
  ): Promise<FlowResult> {
    const { auth } = provider
    if (auth.flow !== "pat") {
      throw new Error(`patFlowEngine: invoked with flow="${auth.flow}"`)
    }

    const store = opts.store ?? new KeychainStore()
    const { ref, legacyRef } = resolveStoreRefs(
      auth.tokenStore,
      opts.server,
      provider.audience,
    )

    if (!opts.force) {
      const existing = await readStoreRefWithFallback(store, ref, legacyRef)
      if (existing) {
        return { accessToken: existing.value, tokenKind: "pat" }
      }
    }

    const token = await promptToken(`${provider.id} personal access token`)
    if (!token) throw new Error("no token provided")

    await store.write(ref, { value: token, kind: "pat" })

    return { accessToken: token, tokenKind: "pat" }
  },
}
