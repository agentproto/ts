/**
 * Template engine: recursive copy of a `templates/<name>/` tree into a
 * target directory, substituting `__APP_ID__` / `__APP_NAME__` /
 * `__APP_SLUG__` tokens in both file contents AND path segments (directory
 * and file names), so e.g. a template dir literally named
 * `__APP_SLUG__-assistant` lands as `my-app-assistant`. `_gitignore` is
 * renamed to `.gitignore` on the way out — npm strips dotfiles from
 * published package contents, so the template ships the escaped name.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface TemplateTokens {
  readonly __APP_ID__: string
  readonly __APP_NAME__: string
  readonly __APP_SLUG__: string
}

const TOKEN_PATTERN = /__APP_(?:ID|NAME|SLUG)__/g

function tokenValue(token: string, tokens: TemplateTokens): string {
  switch (token) {
    case "__APP_ID__":
      return tokens.__APP_ID__
    case "__APP_NAME__":
      return tokens.__APP_NAME__
    case "__APP_SLUG__":
      return tokens.__APP_SLUG__
    default:
      return token
  }
}

function substitute(text: string, tokens: TemplateTokens): string {
  return text.replace(TOKEN_PATTERN, (token) => tokenValue(token, tokens))
}

function renameEntry(name: string): string {
  return name === "_gitignore" ? ".gitignore" : name
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
