// Autonomous Files-tree module — unified-diff renderer for a single
// ChangedFile, used by FileViewer when the open file has working-tree
// changes. Mirrors the DiffRow pattern in ../changes/ChangesPanel.tsx but
// kept local: files/ doesn't import from changes/.

import type { ChangedFile, DiffLine } from "../data/types"

const LINE_PREFIX: Record<DiffLine["kind"], string> = {
  add: "+ ",
  del: "- ",
  ctx: "  ",
  hunk: "",
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div className={`file-diff-row file-diff-row--${line.kind}`}>
      <span className="file-diff-ln">{line.oldLine ?? ""}</span>
      <span className="file-diff-ln">{line.newLine ?? ""}</span>
      <span className="file-diff-tx">
        {line.kind === "hunk" ? line.text : `${LINE_PREFIX[line.kind]}${line.text}`}
      </span>
    </div>
  )
}

export interface FileDiffViewProps {
  file: ChangedFile
}

export function FileDiffView({ file }: FileDiffViewProps) {
  return (
    <div className="file-diff-body">
      {file.lines.map((line, i) => (
        <DiffRow key={i} line={line} />
      ))}
    </div>
  )
}
