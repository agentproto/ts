// Autonomous Files-tree module — read-only viewer for the file selected in
// FilesPanel. Renders monospace content with line numbers; no editing. When
// the open file is a ChangedFile from the session's GitDiff, offers a
// Content/Diff toggle that defaults to Diff.

import { useEffect, useState } from "react"

import type { ChangedFile } from "../data/types"
import "./files.css"
import { FileDiffView } from "./FileDiffView"
import { useFileContent } from "./useFileContent"

export interface FileViewerProps {
  path: string | null
  changedFile?: ChangedFile | null
}

type ViewMode = "content" | "diff"

export function FileViewer({ path, changedFile }: FileViewerProps) {
  const isChanged = changedFile != null
  const [mode, setMode] = useState<ViewMode>(isChanged ? "diff" : "content")

  // Re-derive the default mode whenever the open file changes (or its
  // changed-ness flips), but not on every diff refresh — `isChanged` is a
  // boolean, so a same-file diff refetch that produces a new ChangedFile
  // object doesn't clobber a manual toggle mid-view.
  useEffect(() => {
    setMode(isChanged ? "diff" : "content")
  }, [path, isChanged])

  const { content, truncated, loading, error } = useFileContent(mode === "content" ? path : null)

  if (path === null) {
    return (
      <div className="file-viewer">
        <div className="files-msg">Select a file</div>
      </div>
    )
  }

  const lines = content.length > 0 ? content.split("\n") : []

  return (
    <div className="file-viewer">
      <div className="file-viewer-bar">
        <span className="file-viewer-path">{path}</span>
        {truncated && mode === "content" ? (
          <span className="file-viewer-badge">truncated</span>
        ) : null}
        {isChanged ? (
          <div className="file-viewer-toggle">
            <button
              type="button"
              className={
                mode === "content"
                  ? "file-viewer-toggle-btn file-viewer-toggle-btn--active"
                  : "file-viewer-toggle-btn"
              }
              onClick={() => setMode("content")}
            >
              Content
            </button>
            <button
              type="button"
              className={
                mode === "diff"
                  ? "file-viewer-toggle-btn file-viewer-toggle-btn--active"
                  : "file-viewer-toggle-btn"
              }
              onClick={() => setMode("diff")}
            >
              Diff
            </button>
          </div>
        ) : null}
      </div>
      {mode === "diff" && changedFile ? (
        <div className="file-viewer-body">
          <FileDiffView file={changedFile} />
        </div>
      ) : error ? (
        <div className="files-msg files-msg--error">{error}</div>
      ) : loading ? (
        <div className="files-msg">Loading…</div>
      ) : (
        <div className="file-viewer-body">
          <pre className="file-viewer-pre">
            {lines.map((line, i) => (
              <div key={i} className="file-viewer-line">
                <span className="file-viewer-lineno">{i + 1}</span>
                <span className="file-viewer-text">{line}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
