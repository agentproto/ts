// Autonomous Files-tree panel — renders a nested <ul> file tree for a cwd,
// folders-first. Each directory lazily mounts its own useFileTree level when
// expanded, so the tree fills out on demand rather than in one bulk call.

import { useState } from "react"

import type { GitDiff } from "../data/types"
import "./files.css"
import { matchChangedFile } from "./diffMatch"
import { FileViewer } from "./FileViewer"
import { useFileTree } from "./useFileTree"
import type { FileEntry } from "./useFileTree"

/** Folders before files, then case-insensitive name order. */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
}

interface OpenHandlers {
  openPath: string | null
  onOpen: (path: string) => void
}

interface DiffAware {
  diff: GitDiff | null | undefined
}

function DirNode({
  entry,
  openPath,
  onOpen,
  diff,
}: { entry: FileEntry } & OpenHandlers & DiffAware) {
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
      {open ? (
        <TreeLevel cwd={entry.path} openPath={openPath} onOpen={onOpen} diff={diff} />
      ) : null}
    </li>
  )
}

function FileNode({
  entry,
  openPath,
  onOpen,
  diff,
}: { entry: FileEntry } & OpenHandlers & DiffAware) {
  const active = openPath === entry.path
  const changed = matchChangedFile(diff, entry.path)
  return (
    <li className="files-node files-node--file">
      <button
        type="button"
        className={active ? "files-row files-row--leaf files-row--active" : "files-row files-row--leaf"}
        onClick={() => onOpen(entry.path)}
      >
        <span className="files-chev" />
        <span className="files-icon">📄</span>
        <span className="files-name">{entry.name}</span>
        {changed ? (
          <span className="files-diffstat">
            {changed.added > 0 ? <span className="files-diffstat-add">+{changed.added}</span> : null}
            {changed.removed > 0 ? <span className="files-diffstat-del">-{changed.removed}</span> : null}
          </span>
        ) : null}
      </button>
    </li>
  )
}

function TreeLevel({
  cwd,
  openPath,
  onOpen,
  diff,
}: { cwd: string } & OpenHandlers & DiffAware) {
  const { entries, loading, error } = useFileTree(cwd)

  if (error) return <div className="files-msg files-msg--error">{error}</div>
  if (loading) return <div className="files-msg">Loading…</div>
  if (entries.length === 0) return <div className="files-msg">Empty</div>

  return (
    <ul className="files-list">
      {sortEntries(entries).map((entry) =>
        entry.isDir ? (
          <DirNode key={entry.path} entry={entry} openPath={openPath} onOpen={onOpen} diff={diff} />
        ) : (
          <FileNode key={entry.path} entry={entry} openPath={openPath} onOpen={onOpen} diff={diff} />
        ),
      )}
    </ul>
  )
}

export interface FilesPanelProps {
  cwd?: string | undefined
  diff?: GitDiff | null | undefined
}

export function FilesPanel({ cwd, diff }: FilesPanelProps) {
  const [openPath, setOpenPath] = useState<string | null>(null)
  const changedFile = openPath !== null ? matchChangedFile(diff, openPath) : null

  return (
    <div className="files-split">
      <div className="files-panel">
        {cwd ? (
          <TreeLevel cwd={cwd} openPath={openPath} onOpen={setOpenPath} diff={diff} />
        ) : (
          <div className="files-msg">No working directory for this session.</div>
        )}
      </div>
      <div className="files-viewer-pane">
        <FileViewer path={openPath} changedFile={changedFile} />
      </div>
    </div>
  )
}
