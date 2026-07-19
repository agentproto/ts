// Autonomous Files-tree panel — renders a nested <ul> file tree for a cwd,
// folders-first. Each directory lazily mounts its own useFileTree level when
// expanded, so the tree fills out on demand rather than in one bulk call.

import { useState } from "react"

import "./files.css"
import { useFileTree } from "./useFileTree"
import type { FileEntry } from "./useFileTree"

/** Folders before files, then case-insensitive name order. */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
}

function DirNode({ entry }: { entry: FileEntry }) {
  const [open, setOpen] = useState<boolean>(false)
  return (
    <li className="files-node files-node--dir">
      <button
        type="button"
        className="files-row"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="files-chev">{open ? "▾" : "▸"}</span>
        <span className="files-icon">📁</span>
        <span className="files-name">{entry.name}</span>
      </button>
      {open ? <TreeLevel cwd={entry.path} /> : null}
    </li>
  )
}

function FileNode({ entry }: { entry: FileEntry }) {
  return (
    <li className="files-node files-node--file">
      <span className="files-row files-row--leaf">
        <span className="files-chev" />
        <span className="files-icon">📄</span>
        <span className="files-name">{entry.name}</span>
      </span>
    </li>
  )
}

function TreeLevel({ cwd }: { cwd: string }) {
  const { entries, loading, error } = useFileTree(cwd)

  if (error) return <div className="files-msg files-msg--error">{error}</div>
  if (loading) return <div className="files-msg">Loading…</div>
  if (entries.length === 0) return <div className="files-msg">Empty</div>

  return (
    <ul className="files-list">
      {sortEntries(entries).map((entry) =>
        entry.isDir ? (
          <DirNode key={entry.path} entry={entry} />
        ) : (
          <FileNode key={entry.path} entry={entry} />
        ),
      )}
    </ul>
  )
}

export interface FilesPanelProps {
  cwd?: string | undefined
}

export function FilesPanel({ cwd }: FilesPanelProps) {
  return (
    <div className="files-panel">
      {cwd ? (
        <TreeLevel cwd={cwd} />
      ) : (
        <div className="files-msg">No working directory for this session.</div>
      )}
    </div>
  )
}
