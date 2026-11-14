#!/usr/bin/env node
import { execFile } from "node:child_process"
import { appendFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { casPush } from "../../packages/git-cas/dist/index.mjs"

const run = promisify(execFile)
const MAX_PATCH_BYTES = 1024 * 1024

export function parkMarker(expected) {
  return `<!-- agentic-parked:${expected} -->`
}

export function renderParkComment({
  expected,
  actual,
  actualAuthor = "",
  step = "the fix",
  artifactName = "",
  artifactUrl = "",
  skipCi = false,
}) {
  const author = String(actualAuthor).replace(/^@/, "")
  const artifact = artifactUrl
    ? `[${artifactName || "parked work"}](${artifactUrl})`
    : `\`${artifactName || "parked work"}\``
  const lines = [
    parkMarker(expected),
    `**Parked: the branch head moved before ${step} could push**`,
    "",
    `- expected head: \`${expected}\``,
    `- actual head: \`${actual}\`${author ? ` (pushed by \`${author}\`)` : ""}`,
    `- parked work: ${artifact}`,
    "",
    "The work was not pushed and was not applied onto the new head.",
    "The push that moved the branch starts its own review run; this run dispatches nothing.",
  ]
  if (skipCi) {
    lines.push(
      "",
      "The new head carries `[skip ci]`, so no review run started. Re-issue the fix command after the branch settles.",
    )
  }
  const body = lines.join("\n")
  if (body.startsWith("/") || body.includes("@agentproto-bot")) {
    throw new Error("park comment violates the command trigger constraint")
  }
  return body
}

export async function checkHead({ cwd = process.cwd(), remote = "origin", branch, expected }) {
  if (!branch) throw new Error("branch is required")
  if (!expected) return { moved: true, actual: null, reason: "no expected head" }
  const { stdout } = await run("git", ["ls-remote", remote, `refs/heads/${branch}`], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  const line = stdout.split("\n").find((entry) => entry.endsWith(`\trefs/heads/${branch}`))
  const actual = line ? line.split("\t")[0] : null
  return { moved: actual !== expected, actual }
}

async function resolveAuthor({ cwd, repo, sha }) {
  if (repo && sha) {
    try {
      const { stdout } = await run(
        "gh",
        ["api", `repos/${repo}/commits/${sha}`, "--jq", ".commit.author.name"],
        { cwd },
      )
      const name = stdout.trim()
      if (name) return name
    } catch {
      // fall through to the local object, then to unknown
    }
  }
  try {
    const { stdout } = await run("git", ["show", "-s", "--format=%an", sha], { cwd })
    const name = stdout.trim()
    if (name) return name
  } catch {
    // unknown
  }
  return "unknown"
}

async function commitSubject({ cwd, sha }) {
  try {
    const { stdout } = await run("git", ["show", "-s", "--format=%B", sha], { cwd })
    return stdout.trim()
  } catch {
    return ""
  }
}

export async function writeParkArtifacts({
  cwd = process.cwd(),
  expected,
  actual,
  branch,
  pr = "",
  step = "the fix",
  artifactDir = ".agentflow-park",
  repo = "",
}) {
  const expected7 = String(expected || "unknown").slice(0, 7)
  const artifactName = `parked-fix-${pr || "na"}-${expected7}`
  await mkdir(path.join(cwd, artifactDir), { recursive: true })
  const patchPath = path.join(artifactDir, `${artifactName}.patch`)
  const fullPatchPath = path.join(cwd, patchPath)
  let patch = ""
  try {
    const { stdout } = await run(
      "git",
      ["format-patch", expected ? `${expected}..HEAD` : "--root", "--stdout"],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    )
    patch = stdout
  } catch (err) {
    patch = `could not render the parked commits: ${String(err)}\n`
  }
  let truncated = false
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
    patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n\n[patch truncated at 1 MiB]\n`
    truncated = true
  }
  await writeFile(fullPatchPath, patch, "utf8")
  const actualAuthor = await resolveAuthor({ cwd, repo, sha: actual })
  const actualSubject = await commitSubject({ cwd, sha: actual })
  const skipCi = actualSubject.includes("[skip ci]")
  const metaPath = path.join(artifactDir, `${artifactName}.json`)
  const meta = {
    expected,
    actual,
    actualAuthor,
    actualSubject,
    branch,
    pr,
    step,
    artifactName,
    patchPath,
    truncated,
    skipCi,
  }
  await writeFile(path.join(cwd, metaPath), `${JSON.stringify(meta, null, 2)}\n`, "utf8")
  return { ...meta, metaPath }
}

function writeOutputs(values) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  const lines = []
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    const text = String(value)
    if (text.includes("\n")) {
      const delimiter = `EOF_${key}_${Date.now()}`
      lines.push(`${key}<<${delimiter}`, text, delimiter)
    } else {
      lines.push(`${key}=${text}`)
    }
  }
  appendFileSync(file, `${lines.join("\n")}\n`)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith("--")) {
      args._.push(item)
      continue
    }
    const key = item.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

async function commentBody(meta, artifactUrl) {
  return renderParkComment({
    expected: meta.expected,
    actual: meta.actual,
    actualAuthor: meta.actualAuthor,
    step: meta.step,
    artifactName: meta.artifactName,
    artifactUrl,
    skipCi: meta.skipCi,
  })
}

async function findExistingComment({ repo, pr, marker }) {
  if (!repo || !pr) return null
  try {
    const { stdout } = await run(
      "gh",
      ["api", "--paginate", `repos/${repo}/issues/${pr}/comments`],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    const pages = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return []
        }
      })
    const comments = pages.flat()
    return comments.find((c) => String(c.body || "").includes(marker)) || null
  } catch {
    return null
  }
}

async function postComment({ repo, pr, replyTo, body, marker }) {
  if (!repo || !pr) throw new Error("--repo and --pr are required to comment")
  const existing = await findExistingComment({ repo, pr, marker })
  if (existing) {
    await run("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`])
    return { updated: true, id: existing.id }
  }
  if (replyTo) {
    const attempts = [
      `repos/${repo}/issues/comments/${replyTo}/replies`,
      `repos/${repo}/pulls/comments/${replyTo}/replies`,
    ]
    for (const endpoint of attempts) {
      try {
        const { stdout } = await run("gh", ["api", "-X", "POST", endpoint, "-f", `body=${body}`])
        const parsed = JSON.parse(stdout)
        return { updated: false, id: parsed.id }
      } catch {
        // try the next reply shape
      }
    }
  }
  const { stdout } = await run("gh", ["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`])
  const parsed = JSON.parse(stdout)
  return { updated: false, id: parsed.id }
}

function casInput(args) {
  const expectAbsent = args["expect-absent"] === true
  return {
    cwd: args.cwd || process.cwd(),
    remote: args.remote || "origin",
    branch: args.branch,
    expected: expectAbsent ? { absent: true } : { sha: args.expect },
    localRef: args["local-ref"] || "HEAD",
    noVerify: args["no-verify"] === true,
  }
}

export async function main(argv) {
  const args = parseArgs(argv)
  const command = args._[0]

  if (command === "precheck") {
    const result = await checkHead({
      cwd: args.cwd || process.cwd(),
      remote: args.remote || "origin",
      branch: args.branch,
      expected: args.expect,
    })
    writeOutputs({ moved: result.moved ? "true" : "false", actual: result.actual })
    if (result.moved) {
      console.error(`head moved before the fix: expected ${args.expect || "(none)"}, found ${result.actual || "(none)"}`)
    }
    return 0
  }

  if (command === "comment") {
    const meta = JSON.parse(await readFile(args.meta, "utf8"))
    const body = await commentBody(meta, args["artifact-url"] || "")
    const result = await postComment({
      repo: args.repo || process.env.GITHUB_REPOSITORY || "",
      pr: args.pr || meta.pr,
      replyTo: args["reply-to"],
      body,
      marker: parkMarker(meta.expected),
    })
    console.error(`park comment ${result.updated ? "updated" : "created"} (${result.id})`)
    return 0
  }

  if (command !== "push") {
    console.error("usage: bot-push.mjs push|precheck|comment [options]")
    return 2
  }

  const input = casInput(args)
  const result = await casPush(input, { log: (line) => process.stderr.write(`${line}\n`) })
  const base = {
    cas_outcome: result.outcome,
    cas_expected: "sha" in input.expected ? input.expected.sha : "",
    cas_to: result.outcome === "pushed" || result.outcome === "noop" ? result.to ?? result.sha : "",
    cas_actual: result.outcome === "head_moved" ? result.actual : "",
  }
  if (result.outcome === "rejected_other") {
    base.cas_reason = result.reason
    base.cas_detail = result.detail
  }
  writeOutputs(base)
  process.stdout.write(`${JSON.stringify(result)}\n`)

  if (result.outcome !== "head_moved") {
    return result.outcome === "rejected_other" ? 4 : 0
  }

  const park = await writeParkArtifacts({
    cwd: input.cwd,
    expected: result.expected || "",
    actual: result.actual || "",
    branch: input.branch,
    pr: args.pr || "",
    step: args.step || "the fix",
    artifactDir: args["patch-dir"] || ".agentflow-park",
    repo: args.repo || process.env.GITHUB_REPOSITORY || "",
  })
  writeOutputs({
    cas_actual_author: park.actualAuthor,
    cas_patch_path: park.patchPath,
    cas_park_meta: park.metaPath,
    cas_artifact_name: park.artifactName,
    cas_skip_ci: park.skipCi ? "true" : "false",
  })
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.stack || String(err))
      process.exit(1)
    })
}
