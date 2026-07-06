/**
 * PR creation — host-side `@octokit/rest`.
 *
 * The `PrCreator` interface lets tests stub the octokit call without
 * importing the SDK. Production uses `createOctokitPrCreator`, which
 * lazily constructs an `Octokit` instance with the token from the
 * factory context.
 */

import { Octokit } from "@octokit/rest"
import type { PrPolicy } from "./types.js"

/** Result of a PR-open attempt. */
export interface PrResult {
  prUrl: string
  prNumber: number
}

/** Injectable PR-opener. Production uses octokit; tests stub this. */
export interface PrCreator {
  openPr(input: {
    token: string
    owner: string
    repo: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<PrResult>
}

/**
 * Parse `owner`/`repo` from a GitHub HTTPS clone URL.
 * `https://github.com/owner/repo[.git]` → `{ owner: "owner", repo: "repo" }`.
 */
export function parseGithubRepo(
  repoUrl: string,
): { owner: string; repo: string } {
  const match = repoUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/.?#]+?)(?:\.git)?(?:[/?#].*)?$/)
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `storage-github: parseGithubRepo: could not parse owner/repo from '${repoUrl}'. ` +
        "Expected an HTTPS URL like 'https://github.com/owner/repo'.",
    )
  }
  return { owner: match[1], repo: match[2] }
}

/** Production `PrCreator` backed by `@octokit/rest`. */
export const createOctokitPrCreator = (): PrCreator => ({
  async openPr(input): Promise<PrResult> {
    const octokit = new Octokit({ auth: input.token })
    const res = await octokit.rest.pulls.create({
      owner: input.owner,
      repo: input.repo,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    })
    if (!res.data.html_url) {
      throw new Error(
        `storage-github: octokit pulls.create returned no html_url for ${input.owner}/${input.repo}`,
      )
    }
    return { prUrl: res.data.html_url, prNumber: res.data.number }
  },
})

/**
 * Build the PR title/body from a `PushOptions`-shaped input.
 * Used by both `auto` (opens the PR) and `manual` (returns the title/body
 * as a hint in `PushResult.errors[]`).
 */
export function buildPrText(opts: {
  label?: string
  summary?: string
}): { title: string; body: string } {
  const title = opts.label ? `[agentproto] ${opts.label}` : "[agentproto] sync"
  const body = opts.summary ?? "Automated sync push from agentproto workspace."
  return { title, body }
}

/** Whether the policy opens a PR automatically. */
export function isAutoPr(policy: PrPolicy | undefined): boolean {
  return policy === "auto"
}
