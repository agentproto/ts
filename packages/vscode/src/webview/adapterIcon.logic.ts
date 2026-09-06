/**
 * Adapter / provider / endpoint → logo decision logic shared by the Harnesses
 * and Auth Profiles webviews. No vscode import so it stays unit-testable under
 * plain vitest. Real SVG/PNG files live in `media/icons/adapters/` and are
 * loaded as webview URIs by the panel; this module only decides which file
 * (if any) a given slug should use. Missing art falls back to a circular
 * lettermark badge.
 */

export type AdapterLogo =
  | { kind: "icon"; file: string }
  | { kind: "lettermark"; text: string }

const ICON_FILES: Readonly<Record<string, string>> = {
  "claude-code": "claude.svg",
  "claude-sdk": "anthropic.svg",
  anthropic: "anthropic.svg",
  codex: "openai.svg",
  openai: "openai.svg",
  hermes: "hermes.svg",
  opencode: "opencode.svg",
  mastracode: "mastra.svg",
  "mastracode-inprocess": "mastra.svg",
  "mastra-agent": "mastra.svg",
  openclaw: "openclaw.png",
  browser: "browser.svg",
  deepseek: "deepseek.svg",
  gemini: "gemini.svg",
  "gemini-cli": "gemini.svg",
  "grok-cli": "grok.svg",
  "mistral-vibe": "mistral.svg",
  openrouter: "openrouter.svg",
  "qwen-code": "qwen.svg",
}

const LETTERMARK_OVERRIDES: Readonly<Record<string, string>> = {
  "iflow-cli": "i",
  "kimi-cli": "K",
  "llm-endpoint": "E",
  moonshot: "K",
  pi: "π",
  requesty: "R",
  xai: "X",
}

export function adapterLogoFor(slug: string): AdapterLogo {
  const normalized = slug.trim().toLowerCase()
  const file = ICON_FILES[normalized]
  if (file) return { kind: "icon", file }
  return { kind: "lettermark", text: lettermarkFor(slug) }
}

function lettermarkFor(slug: string): string {
  const normalized = slug.trim().toLowerCase()
  const override = LETTERMARK_OVERRIDES[normalized]
  if (override) return override
  const words = normalized
    .split(/[-_\s]+/)
    .map(w => w.replace(/^[^a-z0-9]+/i, "").replace(/[^a-z0-9]+$/i, ""))
    .filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) {
    const word = words[0]!
    return word.length <= 2 ? word.toUpperCase() : word.slice(0, 1).toUpperCase()
  }
  return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase()
}
