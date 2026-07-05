import { z } from "zod"
import { defineTool } from "@agentproto/tool"

/**
 * AIP-14 contract: create a git worktree off a base ref, on its own branch,
 * optionally installing deps and copying gitignored files (secrets) into it.
 * Agnostic — no hardcoded package manager or env layout; both are inputs.
 */
export const provisionWorktreeTool = defineTool({
  id: "worktree.provision",
  description:
    "Create a git worktree for `repoRoot` at a sibling '_worktrees/<slug>' " +
    "directory, on a new branch 'wt/<slug>' cut from `base`. If `depsCmd` is " +
    "given, it runs inside the new worktree afterwards (e.g. install deps). " +
    "If `copyGlobs` is given, matching files under `repoRoot` (including " +
    "gitignored ones, e.g. local secrets) are copied into the worktree at " +
    "the same relative path. If `linkPaths` is given, each is symlinked from " +
    "`repoRoot` into the worktree before `depsCmd` runs — for gitignored, " +
    "expensive-to-recreate trees a fresh worktree lacks (node_modules, " +
    "sibling workspace repos) so the workspace graph resolves without a full " +
    "reinstall.",
  version: "0.1.0",
  inputSchema: z.object({
    repoRoot: z.string().describe("Absolute path to the git repository root."),
    base: z
      .string()
      .optional()
      .describe("Ref the new branch is cut from. Default 'origin/main'."),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase kebab-case")
      .describe("Short identifier — names both the worktree directory and its branch."),
    depsCmd: z
      .string()
      .optional()
      .describe("Shell command run inside the worktree after creation, e.g. 'pnpm install --prefer-offline'."),
    copyGlobs: z
      .array(z.string())
      .optional()
      .describe("Glob patterns (relative to repoRoot) of gitignored files to copy into the worktree, e.g. 'envs/**/.env.local'."),
    linkPaths: z
      .array(z.string())
      .optional()
      .describe("Relative paths (dirs or files) symlinked from repoRoot into the worktree before depsCmd, e.g. 'node_modules' or a gitignored sibling workspace repo. Lets the workspace graph resolve without a full reinstall."),
  }),
  outputSchema: z.object({
    cwd: z.string().describe("Absolute path to the created worktree."),
    branch: z.string().describe("The branch the worktree was created on."),
  }),
  mutates: ["fs:write"],
  approval: "auto",
  riskLevel: 1,
})
