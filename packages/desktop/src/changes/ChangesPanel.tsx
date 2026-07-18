// WP4 — the right Changes panel: Changes / Files / PR tabs, a branch bar with
// totals + Commit, a changed-file list each expanding to a unified diff, and a
// commits footer. Diff data comes from the git_diff Rust command (shell git).

import { useState } from "react"

import type { ChangedFile, DiffLine, GitDiff } from "../data/types"

type CxTab = "changes" | "files" | "pr"

const LINE_PREFIX: Record<DiffLine["kind"], string> = {
  add: "+ ",
  del: "- ",
  ctx: "  ",
  hunk: "",
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div className={`dl ${line.kind}`}>
      <span className="ln">{line.oldLine ?? ""}</span>
      <span className="ln">{line.newLine ?? ""}</span>
      <span className="tx">
        {line.kind === "hunk" ? line.text : `${LINE_PREFIX[line.kind]}${line.text}`}
      </span>
    </div>
  )
}

function FileRow({ file, defaultOpen }: { file: ChangedFile; defaultOpen: boolean }) {
  return (
    <details className="file" open={defaultOpen}>
      <summary>
        <span className="fn">
          <span className="fp">{file.dir}</span>
          {file.name}
        </span>
        <span className="fs">
          <span className="add">+{file.added}</span> <span className="del">-{file.removed}</span>
        </span>
        <span className="chev">▸</span>
      </summary>
      <div className="diff">
        {file.lines.map((line, i) => (
          <DiffRow key={i} line={line} />
        ))}
      </div>
    </details>
  )
}

interface ChangesPanelProps {
  diff: GitDiff | null
}

export function ChangesPanel({ diff }: ChangesPanelProps) {
  const [tab, setTab] = useState<CxTab>("changes")

  const files = diff?.files ?? []
  const commits = diff?.commits ?? []

  return (
    <div className="cx">
      <div className="cx-tabs">
        <span
          className={`cx-tab${tab === "changes" ? " active" : ""}`}
          onClick={() => setTab("changes")}
        >
          Changes
          {files.length > 0 ? <span className="n">{files.length}</span> : null}
        </span>
        <span
          className={`cx-tab${tab === "files" ? " active" : ""}`}
          onClick={() => setTab("files")}
        >
          Files
        </span>
        <span className={`cx-tab${tab === "pr" ? " active" : ""}`} onClick={() => setTab("pr")}>
          PR
        </span>
      </div>

      {tab === "files" ? (
        <div className="cx-stub">File tree — out of scope for this slice.</div>
      ) : tab === "pr" ? (
        <div className="cx-stub">No PR surface for this session.</div>
      ) : diff && diff.branch ? (
        <>
          <div className="cx-branch">
            <span className="cx-branch-icon">⑂</span>
            <span className="bn">{diff.branch}</span>
            <span className="st">
              <span className="add">+{diff.added}</span> <span className="del">-{diff.removed}</span>
            </span>
            <button className="btn xs">Commit</button>
          </div>
          <div className="cx-scroll">
            {files.length === 0 ? (
              <div className="cx-stub">No file changes in this session yet.</div>
            ) : (
              files.map((file, i) => (
                <FileRow key={file.path} file={file} defaultOpen={i === 0} />
              ))
            )}
          </div>
          <div className="cx-foot">
            <h5>
              Commits <span className="rem">local</span>
            </h5>
            {commits.length === 0 ? (
              <div className="commit commit--empty">No commits yet</div>
            ) : (
              commits.map((c) => (
                <div className="commit" key={c.hash}>
                  <span className="h">{c.hash}</span>
                  {c.message}
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <div className="cx-stub">
          {diff ? "Not a git repository." : "Loading changes…"}
        </div>
      )}
    </div>
  )
}
