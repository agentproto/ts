/**
 * Pure logic for the subscription "connect" (login) sub-flow: the step that
 * turns "paste a token you found somewhere" into "log in and we capture the
 * token the login prints". No vscode import, so it is unit-testable under
 * plain vitest; the command shell (`authProfiles.ts`) drives an integrated
 * Terminal with the command from {@link loginCommandFor}, then captures the
 * printed token with the existing credential InputBox.
 *
 * Today only the Anthropic subscription endpoint has a first-class login
 * (`claude setup-token`, the official long-lived-token command). Other
 * endpoints have no scriptable login yet, so the flow falls back to paste.
 */

import type { AuthMethod } from "../client/types.js"

/** How the user will supply an `oauth-bearer` credential. */
export type CredentialSource = "login" | "paste"

/** A row in the "how do you want to supply the token?" QuickPick. */
export interface CredentialSourceChoice {
  label: string
  description: string
  detail: string
  source: CredentialSource
}

/**
 * A login we can drive in an integrated terminal for a given endpoint. The
 * shell checks {@link LoginCommand.command} is on PATH before offering login;
 * when {@link loginCommandFor} returns `null` the endpoint has no first-class
 * login and the caller skips straight to paste.
 */
export interface LoginCommand {
  /** argv[0] — the binary, so the shell can probe availability. */
  command: string
  /** The full shell line shown in the picker and run in the terminal. */
  commandLine: string
  /** One-line instruction shown alongside the paste box after login. */
  instruction: string
}

/**
 * The login that mints a token for `endpoint` + `method`, or `null` when none
 * exists. Anthropic subscriptions mint a long-lived token via
 * `claude setup-token`; everything else returns `null` (→ paste). Pure.
 */
export function loginCommandFor(
  endpoint: string,
  method: AuthMethod,
): LoginCommand | null {
  if (method !== "oauth-bearer") return null
  if (endpoint === "anthropic") {
    return {
      command: "claude",
      commandLine: "claude setup-token",
      instruction:
        "A terminal opened running `claude setup-token`. Complete the browser " +
        "login, copy the token it prints, then paste it below.",
    }
  }
  return null
}

/**
 * The two ways to supply a subscription credential, given a login is
 * available. When {@link loginCommandFor} returns `null` the caller never
 * shows this pick and goes straight to paste.
 */
export function credentialSourceChoices(
  login: LoginCommand,
): CredentialSourceChoice[] {
  return [
    {
      label: "$(sign-in) Log in to generate a token",
      description: login.commandLine,
      detail: "Opens a terminal, runs the login, then you paste the token it prints.",
      source: "login",
    },
    {
      label: "$(key) Paste a token I already have",
      description: "",
      detail: "Paste an existing subscription bearer token directly.",
      source: "paste",
    },
  ]
}
