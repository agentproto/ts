/**
 * Builtin provision recipes — the credential providers the flow knows out of
 * the box. Shipped as TS literals (not `.md`) so they bundle into the tsup
 * output with zero filesystem read at runtime. A host adds more by parsing its
 * own `.md` with `parseRecipeManifest` and `registerRecipe`-ing the result.
 *
 * Each recipe describes the credential's PUBLIC local convention for that CLI
 * (where it writes its token) — no vendor's private infra, no values.
 */

import { defineProvisionRecipe } from "./define-recipe.js"
import type { ProvisionRecipe } from "./types.js"

/** Claude Code subscription OAuth token. macOS stores it in the login Keychain;
 *  Linux writes it to ~/.claude/.credentials.json. Try the Keychain first, fall
 *  back to the file, so one recipe spans both. */
export const claudeCodeOauthRecipe = defineProvisionRecipe({
  id: "claude-code-oauth",
  description:
    "Claude Code subscription OAuth access token, read from the macOS Keychain or the local CLI's credential file.",
  label: "Claude Code (subscription)",
  methods: [
    {
      id: "subscription-token",
      source: [
        {
          keychain: "Claude Code-credentials",
          jsonPath: "claudeAiOauth.accessToken",
        },
        {
          file: "~/.claude/.credentials.json",
          jsonPath: "claudeAiOauth.accessToken",
        },
      ],
    },
  ],
})

/** Codex CLI — two flavors: the subscription OAuth token, or a raw API key. */
export const codexRecipe = defineProvisionRecipe({
  id: "codex",
  description:
    "OpenAI Codex CLI credential — either the subscription OAuth access token from the local auth file, or an API key from the environment.",
  label: "Codex",
  methods: [
    {
      id: "oauth-subscription",
      label: "Codex (subscription)",
      source: { file: "~/.codex/auth.json", jsonPath: "tokens.access_token" },
    },
    {
      id: "api-key",
      label: "Codex (API key)",
      source: { env: "OPENAI_API_KEY" },
    },
  ],
})

/** opencode — Anthropic (Claude Pro/Max) OAuth login stored by the CLI's own
 *  `opencode auth login` flow. opencode keeps its auth store under the XDG
 *  data dir on every platform (macOS included — verified live). The entry
 *  shape is `{anthropic: {type: "oauth", access, refresh, expires}}`. */
export const opencodeRecipe = defineProvisionRecipe({
  id: "opencode",
  description:
    "opencode's Anthropic (Claude Pro/Max) subscription OAuth access token, read from the CLI's own auth store (written by `opencode auth login`).",
  label: "opencode (Claude subscription)",
  methods: [
    {
      id: "anthropic-oauth",
      source: {
        file: "~/.local/share/opencode/auth.json",
        jsonPath: "anthropic.access",
      },
    },
  ],
})

/** mastracode — Anthropic (Claude Pro/Max) OAuth login from the TUI's own
 *  `/login` flow. mastracode's app-data dir is platform-dependent
 *  (`getAppDataDir()` in its source: Application Support on macOS, XDG data
 *  dir elsewhere); the entry shape is `{anthropic: {type: "oauth", access,
 *  refresh, expires}}` — verified against a live login. */
export const mastracodeRecipe = defineProvisionRecipe({
  id: "mastracode",
  description:
    "mastracode's Anthropic (Claude Pro/Max) subscription OAuth access token, read from the CLI's own auth store (written by its /login flow).",
  label: "mastracode (Claude subscription)",
  methods: [
    {
      id: "anthropic-oauth",
      source: [
        {
          file: "~/Library/Application Support/mastracode/auth.json",
          jsonPath: "anthropic.access",
        },
        {
          file: "~/.local/share/mastracode/auth.json",
          jsonPath: "anthropic.access",
        },
      ],
    },
  ],
})

/** Gemini CLI OAuth token written by the local CLI. */
export const geminiRecipe = defineProvisionRecipe({
  id: "gemini",
  description:
    "Google Gemini CLI OAuth access token, read from the local CLI's credential cache.",
  label: "Gemini",
  methods: [
    {
      id: "oauth-token",
      source: {
        file: "~/.gemini/oauth_creds.json",
        jsonPath: "access_token",
      },
    },
  ],
})

export const BUILTIN_RECIPES: readonly ProvisionRecipe[] = [
  claudeCodeOauthRecipe,
  codexRecipe,
  geminiRecipe,
  opencodeRecipe,
  mastracodeRecipe,
]
