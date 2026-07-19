// Autonomous Files-tree module — read-only viewer for the file selected in
// FilesPanel. Renders monospace content with line numbers; no editing.

import "./files.css"
import { useFileContent } from "./useFileContent"

export interface FileViewerProps {
  path: string | null
}

export function FileViewer({ path }: FileViewerProps) {
  const { content, truncated, loading, error } = useFileContent(path)

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
        {truncated ? <span className="file-viewer-badge">truncated</span> : null}
      </div>
      {error ? (
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
