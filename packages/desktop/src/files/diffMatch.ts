// Autonomous Files-tree module — matches a file-tree path to its GitDiff
// entry, if any. `useFileTree`/`list_dir` produce absolute paths (see
// list_dir's contract comment in src-tauri/src/lib.rs), while
// `ChangedFile.path` is always repo-root-relative. We don't know the repo
// root at this layer (FilesPanel's `cwd` may itself be a subdirectory of the
// repo, e.g. a monorepo package), so we match by suffix instead: an absolute
// path belongs to a ChangedFile when it equals, or ends with "/" + that
// file's relative path. This is safe because `ChangedFile.path` always
// carries every directory segment down from the repo root, so two distinct
// files can't share that suffix.

import type { ChangedFile, GitDiff } from "../data/types"

export function matchChangedFile(
  diff: GitDiff | null | undefined,
  path: string,
): ChangedFile | null {
  if (!diff) return null
  for (const file of diff.files) {
    if (path === file.path || path.endsWith(`/${file.path}`)) return file
  }
  return null
}
