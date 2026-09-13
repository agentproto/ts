// @vitest-environment jsdom
/**
 * DOM-level coverage for the transcript markdown renderer: the string
 * `renderMarkdown` emits must parse into the table structure the webview
 * relies on (thead/tbody, per-cell alignment, formatted cell contents).
 *
 * packages/vscode excludes the DOM lib on purpose, so this leans on the
 * hand-declared jsdom surface in jsdom.d.ts (querySelector/textContent/
 * innerHTML) rather than global Document/HTMLElement types.
 */

import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

import { renderMarkdown } from "./markdown.js"
import type { DomElement, DomWindow } from "jsdom"

const openWindows: DomWindow[] = []

function render(md: string): DomElement {
  const dom = new JSDOM(
    `<!DOCTYPE html><body><div id="transcript">${renderMarkdown(md)}</div></body>`,
  )
  openWindows.push(dom.window)
  const root = dom.window.document.getElementById("transcript")
  if (!root) throw new Error("transcript root not found")
  return root
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
})

describe("markdown table DOM rendering", () => {
  it("builds a table with head and body rows", () => {
    const root = render("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")
    expect(root.querySelector("table")).not.toBeNull()

    const headers = [...root.querySelectorAll("thead th")].map(th => th.textContent)
    expect(headers).toEqual(["a", "b"])

    const bodyRows = [...root.querySelectorAll("tbody tr")]
    expect(bodyRows.length).toBe(2)
    const firstRow = [...bodyRows[0]!.querySelectorAll("td")].map(td => td.textContent)
    expect(firstRow).toEqual(["1", "2"])
  })

  it("carries column alignment onto the cells", () => {
    const root = render("| l | r |\n| :--- | ---: |\n| 1 | 2 |")
    const headers = [...root.querySelectorAll("thead th")]
    expect(headers[0]!.innerHTML).toBe("l")
    // Alignment rides as an inline style attribute, visible in the parsed HTML.
    expect(root.innerHTML).toContain("text-align:left")
    expect(root.innerHTML).toContain("text-align:right")
  })

  it("renders inline formatting as real elements inside cells", () => {
    const root = render("| name |\n|---|\n| **bold** `code` |")
    const cell = root.querySelector("tbody td")
    expect(cell!.querySelector("strong")?.textContent).toBe("bold")
    expect(cell!.querySelector("code")?.textContent).toBe("code")
  })

  it("keeps a pipe inside a code span from splitting the cell", () => {
    const root = render("| a | b |\n|---|---|\n| `x | y` | z |")
    const cells = [...root.querySelectorAll("tbody td")]
    expect(cells.length).toBe(2)
    expect(cells[0]!.querySelector("code")?.textContent).toBe("x | y")
    expect(cells[1]!.textContent).toBe("z")
  })

  it("leaves a block with no valid separator as plain text, not a table", () => {
    const root = render("| a | b |\n| c | d |")
    expect(root.querySelector("table")).toBeNull()
    expect(root.textContent).toContain("| a | b |")
  })
})
