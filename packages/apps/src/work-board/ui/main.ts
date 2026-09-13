import "./style.css"
import { renderColumns, type CardAction } from "./render.js"
import type { Task, TaskCreateResult, TaskListResult, TaskWriteReply } from "./types.js"

function getEl(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`work board: missing #${id}`)
  return el
}

function getInput(id: string): HTMLInputElement {
  const el = document.getElementById(id)
  if (!(el instanceof HTMLInputElement)) throw new Error(`work board: missing input #${id}`)
  return el
}

function isCardAction(value: string): value is CardAction {
  switch (value) {
    case "claim":
    case "start":
    case "done":
    case "fail":
    case "release":
    case "cancel":
    case "reopen":
      return true
    default:
      return false
  }
}

let boardId: string | null = null
let tasks: Task[] = []
let pollActive = false

/**
 * Everything below reads the `#app` markup, so it only runs once the
 * document has actually finished parsing — see the DOMContentLoaded guard
 * at the bottom of this file. Vite emits this bundle as a plain classic
 * script (see build-work-board-ui.mjs's rewrite of the `type="module"` tag,
 * needed for jsdom's render smoke test), and vite-plugin-singlefile
 * relocates it into `<head>`, ahead of the `<body>` markup — neither a bare
 * classic script nor `defer` on an inline script (a no-op per spec) would
 * otherwise guarantee `#columns` etc. exist yet.
 */
function boot(): void {
  const columnsEl = getEl("columns")
  const statusbarEl = getEl("statusbar")
  const boardIdEl = getEl("board-id")
  const boardInputEl = getInput("board-input")
  const newTitleEl = getInput("new-title")

  function setStatus(msg: string): void {
    statusbarEl.textContent = msg
  }

  function render(): void {
    boardIdEl.textContent = boardId ?? "—"
    if (!boardInputEl.value) boardInputEl.value = boardId ?? ""
    columnsEl.innerHTML = renderColumns(tasks)
  }

  function findTask(taskId: string): Task | undefined {
    return tasks.find(t => t.taskId === taskId)
  }

  function loadBoard(): Promise<void> {
    const args: { includeClosed: boolean; full: boolean; boardId?: string } = {
      includeClosed: true,
      full: true,
      ...(boardId ? { boardId } : {}),
    }
    return callTool<typeof args, TaskListResult>("task_list", args)
      .then(data => {
        boardId = data.boardId ?? boardId
        tasks = data.tasks ?? []
        render()
        setStatus(`${tasks.length} task${tasks.length === 1 ? "" : "s"} · ${new Date().toLocaleTimeString()}`)
      })
      .catch((e: Error) => {
        setStatus(`Error: ${e.message}`)
      })
  }

  function applyAction(taskId: string, action: CardAction): void {
    const task = findTask(taskId)
    if (!task) return

    const base = { taskId: task.taskId, rev: task.rev }
    let promise: Promise<TaskWriteReply>
    if (action === "claim") {
      promise = callTool("task_claim", base)
    } else if (action === "start") {
      promise = callTool("task_update", { ...base, status: "in_progress" })
    } else if (action === "done") {
      promise = callTool("task_update", { ...base, status: "done" })
    } else if (action === "fail") {
      promise = callTool("task_update", { ...base, status: "failed" })
    } else if (action === "release") {
      promise = callTool("task_update", { ...base, owner: null })
    } else if (action === "cancel") {
      promise = callTool("task_update", { ...base, status: "cancelled" })
    } else {
      promise = callTool("task_update", { ...base, status: "pending" })
    }

    promise
      .then(result => {
        if ("conflict" in result) {
          setStatus(`Someone else moved "${task.title}" first — refreshed.`)
        } else if ("error" in result) {
          setStatus(`Action failed: ${result.error}`)
        } else {
          setStatus(`Updated "${task.title}".`)
        }
        return loadBoard()
      })
      .catch((e: Error) => {
        setStatus(`Action failed: ${e.message}`)
      })
  }

  function doPoll(): void {
    if (pollActive) return
    pollActive = true
    loadBoard().finally(() => {
      pollActive = false
      setTimeout(doPoll, 4000)
    })
  }

  columnsEl.addEventListener("click", evt => {
    if (!(evt.target instanceof Element)) return
    const btn = evt.target.closest("button[data-action]")
    if (!(btn instanceof HTMLButtonElement)) return
    const taskId = btn.getAttribute("data-taskid")
    const action = btn.getAttribute("data-action")
    if (!taskId || !action || !isCardAction(action)) return
    applyAction(taskId, action)
  })

  getEl("refresh-btn").addEventListener("click", () => {
    void loadBoard()
  })

  getEl("go-btn").addEventListener("click", () => {
    const value = boardInputEl.value.trim()
    if (!value) return
    boardId = value
    void loadBoard()
  })

  getEl("add-btn").addEventListener("click", () => {
    const title = newTitleEl.value.trim()
    if (!title) return
    const args = boardId ? { title, boardId } : { title }
    callTool<typeof args, TaskCreateResult>("task_create", args)
      .then(result => {
        if (result.error) {
          setStatus(`Create failed: ${result.error}`)
          return undefined
        }
        newTitleEl.value = ""
        setStatus(`Created "${title}".`)
        return loadBoard()
      })
      .catch((e: Error) => {
        setStatus(`Create failed: ${e.message}`)
      })
  })

  initBridge()
    .then(() => loadBoard())
    .then(() => {
      setTimeout(doPoll, 4000)
    })
    .catch((e: Error) => {
      setStatus(`Bridge error: ${e.message}`)
    })
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot)
} else {
  boot()
}
