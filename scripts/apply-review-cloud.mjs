#!/usr/bin/env node
/**
 * Agentic review fixer — Claude Code Cloud backend.
 *
 * The peer of `apply-review.mjs` (an Anthropic Messages API tool-loop) for the
 * case where the fix should run on the Claude subscription via a managed
 * Claude Code Cloud session rather than the metered ANTHROPIC_API_KEY. A cloud
 * session cannot write our CI working tree (the vendor owns the machine), so
 * — exactly like the docs-check cloud lane — it returns the fixes as a unified
 * git diff, which this script validates and applies locally. The caller's
 * "Commit and push fixes" step then commits whatever changed.
 *
 * Usage: node scripts/apply-review-cloud.mjs [--delivery commit|pr]
 * Env: PR_NUMBER, GITHUB_REPOSITORY, GITHUB_TOKEN,
 *      CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CLOUD_OAUTH_TOKEN (all required).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const RUNNER_TEMP = process.env.RUNNER_TEMP || "/tmp";

const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
if (!PR_NUMBER) {
  console.error("Error: PR_NUMBER env var is required.");
  process.exit(1);
}
if (!REPO) {
  console.error("Error: GITHUB_REPOSITORY env var is required.");
  process.exit(1);
}
for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CLOUD_OAUTH_TOKEN"]) {
  if (!process.env[name]) {
    console.error(`Error: ${name} env var is required for the cloud fixer.`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const delIdx = args.indexOf("--delivery");
const DELIVERY = delIdx !== -1 ? args[delIdx + 1] : "commit";

function gh(endpoint) {
  const env = { ...process.env };
  if (TOKEN) env.GH_TOKEN = TOKEN;
  return JSON.parse(
    execFileSync("gh", ["api", "--paginate", endpoint], {
      cwd: ROOT,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

// ── gather the review + diff the model must act on ───────────────────────────

const reviews = gh(`repos/${REPO}/pulls/${PR_NUMBER}/reviews`);
const latest = [...reviews]
  .reverse()
  .find((r) => r.state === "CHANGES_REQUESTED");
if (!latest) {
  console.log("No CHANGES_REQUESTED review to fix — nothing to do.");
  process.exit(0);
}
const inline = gh(`repos/${REPO}/pulls/${PR_NUMBER}/comments`);
const diff = execFileSync("gh", ["pr", "diff", PR_NUMBER, "--repo", REPO], {
  cwd: ROOT,
  encoding: "utf8",
});

const inlineBlock = inline.length
  ? inline
      .map(
        (c) =>
          `- ${c.path}${c.line ? `:${c.line}` : ""} — ${String(c.body || "").trim()}`,
      )
      .join("\n")
  : "(no inline comments)";

const prompt = `You are fixing the requested changes on pull request #${PR_NUMBER} of the @agentproto/ts monorepo. Work read-only against the code you can see; your ONLY output is a patch.

## The review requesting changes

${String(latest.body || "").trim()}

## Inline comments

${inlineBlock}

## The pull request diff

\`\`\`diff
${diff}
\`\`\`

## Your task

Apply the fixes the review asks for, addressing every finding. Read the surrounding code as needed. Make the minimal change that satisfies each comment and do not make unrelated changes.

CLOUD TRANSFER MODE:
- Work in your remote checkout and make the fixes there.
- Your FINAL response must be exactly the resulting unified git diff, with no prose and no markdown fence.
- If no edits are needed, respond with exactly NO_CHANGES.
- Never commit, push, open a pull request, or call an external service.
- Never add AI/Claude/Anthropic attribution to any file or message.`;

const promptFile = resolve(
  RUNNER_TEMP,
  `apply-review-cloud-${PR_NUMBER}.prompt`,
);
const patchFile = resolve(RUNNER_TEMP, `apply-review-cloud-${PR_NUMBER}.patch`);
writeFileSync(promptFile, prompt, "utf8");

console.log(`\n🔧 Cloud review fixer — PR #${PR_NUMBER} delivery=${DELIVERY}`);
execFileSync(
  process.execPath,
  [
    resolve(ROOT, "scripts/claude-cloud-ci.mjs"),
    "--prompt-file",
    promptFile,
    "--output",
    patchFile,
    "--label",
    "ci-fix-cloud",
  ],
  { cwd: ROOT, stdio: "inherit" },
);

// ── validate + apply the returned patch ──────────────────────────────────────

const output = readFileSync(patchFile, "utf8").trim();
if (output === "NO_CHANGES" || output === "") {
  console.log("Cloud fixer found nothing to change.");
  process.exit(0);
}
if (!output.startsWith("diff --git ")) {
  throw new Error(
    "Cloud fixer output is neither NO_CHANGES nor a unified git diff",
  );
}
const patch = output + "\n";
const options = { cwd: ROOT, input: patch, encoding: "utf8" };
execFileSync("git", ["apply", "--check"], options);

// The fixer may edit any repo file the review touches, but must never escape
// the working tree, touch .git, or hide a path behind a rename/copy directive
// (a rename's destination-only numstat would let a scope check be bypassed).
const bad = (p) =>
  p.startsWith("/") ||
  p === ".git" ||
  p.startsWith(".git/") ||
  p.split("/").includes("..");
for (const line of patch.split("\n")) {
  let m;
  if (
    (m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)) ||
    (m = /^--- a\/(.+)$/.exec(line)) ||
    (m = /^\+\+\+ b\/(.+)$/.exec(line))
  ) {
    for (const p of m.slice(1))
      if (p && bad(p))
        throw new Error(`Cloud fix patch touches an out-of-tree path: ${p}`);
  } else if (/^(?:rename|copy) (?:from|to) /.test(line)) {
    throw new Error(
      `Cloud fix patch uses a rename/copy directive (${line.trim()}) — not allowed`,
    );
  }
}

execFileSync("git", ["apply", "--whitespace=error-all"], options);
console.log("Applied the cloud fix patch.");
