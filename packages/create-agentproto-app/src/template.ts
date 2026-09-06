/**
 * Template engine: recursive copy of a `templates/<name>/` tree into a
 * target directory, substituting `__APP_ID__` / `__APP_NAME__` /
 * `__APP_SLUG__` / `__APP_CLIENT_VERSION__` tokens in both file contents AND
 * path segments (directory and file names), so e.g. a template dir literally
 * named `__APP_SLUG__-assistant` lands as `my-app-assistant`. `_gitignore`
 * is renamed to `.gitignore` on the way out — npm strips dotfiles from
 * published package contents, so the template ships the escaped name.
 * `_agentproto/` is renamed to `.agentproto/` for the same escaping reason,
 * plus a nearer trap: this monorepo's root `.gitignore` ignores
 * `.agentproto/` at any depth (it's the daemon's workspace-state dir), so a
 * literal `.agentproto/` template tree would silently never be committed.
 * `_claude/` is renamed to `.claude/` for the same npm-publish reason — the
 * `book` template ships a Claude Code skill there.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface TemplateTokens {
  readonly __APP_ID__: string
  readonly __APP_NAME__: string
  readonly __APP_SLUG__: string
  readonly __APP_CLIENT_VERSION__: string
}

const TOKEN_PATTERN = /__APP_(?:ID|NAME|SLUG|CLIENT_VERSION)__/g

function tokenValue(token: string, tokens: TemplateTokens): string {
  switch (token) {
    case "__APP_ID__":
      return tokens.__APP_ID__
    case "__APP_NAME__":
      return tokens.__APP_NAME__
    case "__APP_SLUG__":
      return tokens.__APP_SLUG__
    case "__APP_CLIENT_VERSION__":
      return tokens.__APP_CLIENT_VERSION__
    default:
      return token
  }
}

function substitute(text: string, tokens: TemplateTokens): string {
  return text.replace(TOKEN_PATTERN, (token) => tokenValue(token, tokens))
}

const RENAME_BY_NAME: Readonly<Record<string, string>> = {
  _gitignore: ".gitignore",
  _agentproto: ".agentproto",
  _claude: ".claude",
}

function renameEntry(name: string): string {
  return RENAME_BY_NAME[name] ?? name
}

/** Recursively copy `srcDir` into `destDir`, returning the file count written. */
export async function copyTemplateDir(
  srcDir: string,
  destDir: string,
  tokens: TemplateTokens,
): Promise<number> {
  await mkdir(destDir, { recursive: true })
  let fileCount = 0
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    const destName = renameEntry(substitute(entry.name, tokens))
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, destName)
    if (entry.isDirectory()) {
      fileCount += await copyTemplateDir(srcPath, destPath, tokens)
    } else if (entry.isFile()) {
      const raw = await readFile(srcPath, "utf8")
      await writeFile(destPath, substitute(raw, tokens), "utf8")
      fileCount += 1
    }
  }
  return fileCount
}
