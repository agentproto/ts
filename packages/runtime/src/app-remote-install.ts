/**
 * Remote sources for `app_install` / `app_resync`: git URLs and `.agentapp`
 * bundles (URL or local file). Pure staging + swap — no registry, no
 * validation: `app-tools.ts` runs `performInstall` on whatever this hands
 * back, so the same manifest checks apply to every source.
 *
 * Remote-installed apps live under `<appsDir>/<slug>` (the daemon state dir's
 * `apps/`), never in the user's cwd. A (re)install stages into a hidden
 * sibling temp dir first and swaps it in, so a failed clone / digest mismatch
 * / manifest error leaves the previous install untouched.
 */

import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { z } from "zod"
import { safeId, unpackApp } from "@agentproto/app-kit"
import type { AppSource } from "./app-registry.js"

export const DOWNLOAD_TIMEOUT_MS = 30_000
export const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024
const GIT_TIMEOUT_MS = 5 * 60_000

// ── input schema ────────────────────────────────────────────────────────

const dataDirField = z.string().optional()

/** `app_install` input: exactly one of `{dir}` | `{url, ref?, subdir?, sha?, sha256?, allowBuild?}` | `{file, sha256?}`. */
export const appInstallInputSchema = z.union([
  z.object({ dir: z.string(), dataDir: dataDirField }).strict(),
  z
    .object({
      url: z.string(),
      ref: z.string().optional(),
      subdir: z.string().optional(),
      sha: z.string().optional(),
      sha256: z.string().optional(),
      allowBuild: z.boolean().optional(),
      catalogUrl: z.string().optional(),
      dataDir: dataDirField,
    })
    .strict(),
  z.object({ file: z.string(), sha256: z.string().optional(), catalogUrl: z.string().optional(), dataDir: dataDirField }).strict(),
])
export type AppInstallInput = z.infer<typeof appInstallInputSchema>

export const APP_INSTALL_EXCLUSIVE_ERROR =
  "pass exactly one source: {dir} (local app dir), {url, ref?, subdir?, sha?, allowBuild?} (git repo), " +
  "{url, sha256?} (a .agentapp URL), or {file, sha256?} (local .agentapp path); `dataDir` may accompany any of them, `catalogUrl` any remote one."

/** A `{url}` ending in `.agentapp` (ignoring query/fragment) is a bundle, anything else is git. */
export function isAgentappUrl(url: string): boolean {
  return /\.agentapp$/i.test(url.split(/[?#]/)[0]!)
}

// ── staging ─────────────────────────────────────────────────────────────

export interface StagedApp {
  /** Directory name under `appsDir` the staged tree will be swapped into. */
  readonly slug: string
  /** Hidden sibling of the final dir holding the staged tree. */
  readonly tmpDir: string
  /** Path of the app dir inside the staged tree (`subdir` for git, `""` otherwise). */
  readonly subdir: string
  readonly source: AppSource
  /** Remove the staged tree (idempotent) — call when the stage is not swapped in. */
  discard(): Promise<void>
}

function tmpSibling(appsDir: string, slug: string): string {
  return join(appsDir, `.tmp-${slug}-${randomUUID().slice(0, 8)}`)
}

function sanitizeSlug(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-+$/, "")
  return s === "" ? "app" : s
}

/** `<repo-name>[-<subdir-slug>]` — repo name is the URL's last path segment minus `.git`. */
export function gitSlug(url: string, subdir?: string): string {
  const tail = url.replace(/[?#].*$/, "").replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? ""
  const repo = sanitizeSlug(tail.replace(/\.git$/i, ""))
  if (subdir === undefined || subdir === "") return repo
  return sanitizeSlug(`${repo}-${subdir.split(/[\\/]+/).filter(Boolean).join("-")}`)
}

function assertGitUrl(url: string): void {
  if (url.trim() === "" || url.startsWith("-") || url.includes("::")) {
    throw new Error(`"${url}" is not a usable git URL.`)
  }
}

function git(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      [...args],
      {
        ...(cwd !== undefined ? { cwd } : {}),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr).trim() || err.message
          fail(new Error(`git ${args[0]} failed: ${detail}`))
        } else done(String(stdout))
      },
    )
  })
}

function normalizeSubdir(subdir: string | undefined): string {
  if (subdir === undefined) return ""
  const trimmed = subdir.trim()
  if (trimmed === "" || trimmed === ".") return ""
  if (isAbsolute(trimmed) || trimmed.split(/[\\/]/).includes("..")) {
    throw new Error(`subdir "${subdir}" must be a relative path inside the repo.`)
  }
  return trimmed.replace(/^\.[\\/]/, "").replace(/[\\/]+$/, "")
}

/** Shallow-clone `url` into a temp sibling of `<appsDir>/<slug>` and pin the commit. */
export async function stageGitApp(input: {
  appsDir: string
  url: string
  ref?: string
  subdir?: string
  expectedSha?: string
}): Promise<StagedApp> {
  assertGitUrl(input.url)
  const subdir = normalizeSubdir(input.subdir)
  const slug = gitSlug(input.url, subdir)
  await mkdir(input.appsDir, { recursive: true })
  const tmpDir = tmpSibling(input.appsDir, slug)
  const discard = (): Promise<void> => rm(tmpDir, { recursive: true, force: true })
  try {
    await git([
      "clone",
      "--depth",
      "1",
      ...(input.ref !== undefined ? [`--branch=${input.ref}`] : []),
      "--",
      input.url,
      tmpDir,
    ])
    const sha = (await git(["rev-parse", "HEAD"], tmpDir)).trim()
    if (input.expectedSha !== undefined && sha.toLowerCase() !== input.expectedSha.trim().toLowerCase()) {
      throw new Error(
        `git commit mismatch for ${input.url}: expected ${input.expectedSha.trim()}, got ${sha}. Nothing was installed.`,
      )
    }
    if (subdir !== "") {
      let real: string
      try {
        real = await realpath(join(tmpDir, subdir))
      } catch {
        throw new Error(`subdir "${subdir}" does not exist in ${input.url}.`)
      }
      const root = await realpath(tmpDir)
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`subdir "${subdir}" resolves outside the repo.`)
      }
      if (!(await stat(real)).isDirectory()) throw new Error(`subdir "${subdir}" is not a directory.`)
    }
    return {
      slug,
      tmpDir,
      subdir,
      source: {
        kind: "git",
        url: input.url,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        sha,
        ...(subdir !== "" ? { subdir } : {}),
      },
      discard,
    }
  } catch (err) {
    await discard()
    throw err
  }
}

/** Stream `url` (http(s):// or file://) to `destFile` under the timeout + size cap. */
async function downloadTo(url: string, destFile: string): Promise<void> {
  if (url.startsWith("file:")) {
    const src = fileURLToPath(url)
    if ((await stat(src)).size > DOWNLOAD_MAX_BYTES) {
      throw new Error(`${url} exceeds the ${DOWNLOAD_MAX_BYTES / 1024 / 1024} MB cap.`)
    }
    await copyFile(src, destFile)
    return
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" })
  if (!res.ok || res.body === null) throw new Error(`download of ${url} failed: HTTP ${res.status}`)
  const declared = Number(res.headers.get("content-length") ?? "0")
  if (declared > DOWNLOAD_MAX_BYTES) {
    throw new Error(`${url} is ${declared} bytes, over the ${DOWNLOAD_MAX_BYTES / 1024 / 1024} MB cap.`)
  }
  const out = await open(destFile, "w")
  try {
    let total = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > DOWNLOAD_MAX_BYTES) {
        await reader.cancel()
        throw new Error(`${url} exceeds the ${DOWNLOAD_MAX_BYTES / 1024 / 1024} MB cap.`)
      }
      await out.write(value)
    }
  } finally {
    await out.close()
  }
}

/**
 * Fetch (or read) a `.agentapp`, verify + unpack it into a temp sibling of
 * `<appsDir>/<safe-id>`. A digest mismatch (or any unpack refusal) throws and
 * leaves nothing behind.
 */
export async function stageAgentApp(input: {
  appsDir: string
  url?: string
  file?: string
  expectedSha256?: string
}): Promise<StagedApp> {
  await mkdir(input.appsDir, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), "agentapp-dl-"))
  const tmpDir = join(input.appsDir, `.tmp-agentapp-${randomUUID().slice(0, 8)}`)
  const discard = (): Promise<void> => rm(tmpDir, { recursive: true, force: true })
  try {
    let bundle: string
    let url: string
    if (input.file !== undefined) {
      bundle = resolve(input.file)
      url = pathToFileURL(bundle).href
    } else if (input.url !== undefined) {
      url = input.url
      if (!/^(https?|file):\/\//i.test(url)) {
        throw new Error(`.agentapp url must be https://, http:// or file:// (got "${url}").`)
      }
      bundle = join(scratch, "download.agentapp")
      await downloadTo(url, bundle)
    } else {
      throw new Error("stageAgentApp needs a url or a file.")
    }
    const { manifest } = await unpackApp({ file: bundle, dest: tmpDir })
    if (
      input.expectedSha256 !== undefined &&
      manifest.sha256.toLowerCase() !== input.expectedSha256.trim().toLowerCase()
    ) {
      throw new Error(
        `.agentapp digest mismatch for ${url}: expected sha256 ${input.expectedSha256.trim()}, ` +
          `bundle declares ${manifest.sha256}. Nothing was installed.`,
      )
    }
    return {
      slug: sanitizeSlug(safeId(manifest.id)),
      tmpDir,
      subdir: "",
      source: { kind: "agentapp", url, sha256: manifest.sha256, version: manifest.version },
      discard,
    }
  } catch (err) {
    await discard()
    throw err
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

// ── swap ────────────────────────────────────────────────────────────────

export interface AppSwap {
  /** Drop the previous tree — the new one is final. */
  commit(): Promise<void>
  /** Put the previous tree (and its data) back, discarding the new one. */
  rollback(): Promise<void>
}

/**
 * Swap the staged tree in at `target`, keeping the previous tree aside until
 * the caller commits. When the previous install's `dataDir` lived inside the
 * old tree (the `<dir>/data` default), it is carried into the new tree so a
 * re-install never loses app data.
 */
export async function swapInStaged(input: {
  tmpDir: string
  target: string
  previousDataDir?: string
}): Promise<AppSwap> {
  const { tmpDir, target } = input
  let backup: string | undefined
  try {
    await stat(target)
    backup = `${target}.old-${randomUUID().slice(0, 8)}`
  } catch {
    // first install — nothing to keep aside
  }
  if (backup !== undefined) await rename(target, backup)
  try {
    await rename(tmpDir, target)
  } catch (err) {
    if (backup !== undefined) await rename(backup, target)
    throw err
  }

  let carriedRel: string | undefined
  if (backup !== undefined && input.previousDataDir !== undefined) {
    const rel = relative(target, input.previousDataDir)
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      const from = join(backup, rel)
      try {
        await stat(from)
        await rm(join(target, rel), { recursive: true, force: true })
        await mkdir(dirname(join(target, rel)), { recursive: true })
        await rename(from, join(target, rel))
        carriedRel = rel
      } catch {
        // no data dir on disk yet — nothing to carry
      }
    }
  }

  return {
    async commit() {
      if (backup !== undefined) await rm(backup, { recursive: true, force: true })
    },
    async rollback() {
      if (carriedRel !== undefined && backup !== undefined) {
        await mkdir(dirname(join(backup, carriedRel)), { recursive: true })
        await rename(join(target, carriedRel), join(backup, carriedRel))
      }
      await rm(target, { recursive: true, force: true })
      if (backup !== undefined) await rename(backup, target)
    },
  }
}

// ── resync probe ────────────────────────────────────────────────────────

/** The commit `url`'s `ref` (default `HEAD`) currently points at, via `git ls-remote`. */
export async function remoteGitSha(url: string, ref?: string): Promise<string> {
  assertGitUrl(url)
  if (ref === undefined) {
    const line = (await git(["ls-remote", "--", url, "HEAD"])).split("\n")[0] ?? ""
    const sha = line.split(/\s+/)[0]
    if (!sha) throw new Error(`${url} has no HEAD.`)
    return sha
  }
  const out = await git(["ls-remote", "--", url, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`])
  const byRef = new Map<string, string>()
  for (const line of out.split("\n")) {
    const [sha, name] = line.split(/\s+/)
    if (sha && name) byRef.set(name, sha)
  }
  // Peeled tag (`^{}`) is the commit an annotated tag points at — what a clone checks out.
  const sha = byRef.get(`refs/heads/${ref}`) ?? byRef.get(`refs/tags/${ref}^{}`) ?? byRef.get(`refs/tags/${ref}`)
  if (!sha) throw new Error(`ref "${ref}" not found in ${url}.`)
  return sha
}
