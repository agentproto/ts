/**
 * Minimal `vscode` module mock so modules that import vscode for
 * EventEmitter / Disposable / TreeItem types load under plain vitest
 * (Node, no extension host). Only the surface the pure-logic tests touch
 * is implemented; anything else throws to surface unexpected usage.
 *
 * Wired via the vitest alias in vitest.config.ts. Kept deliberately
 * self-contained (no `import vscode`) so the alias doesn't recurse.
 */

export type Event<T> = (listener: (e: T) => void) => void

export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => void>()
  readonly event: Event<T> = (listener: (e: T) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e)
  }
  dispose(): void {
    this.listeners.clear()
  }
}

export class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.()
  }
}

export interface TreeItemOptions {
  label?: string
}

export class TreeItem {
  label: string | TreeItemOptions
  description?: string
  tooltip?: string | undefined
  constructor(label: string | TreeItemOptions, _collapsibleState?: number) {
    this.label = label
    void _collapsibleState
  }
}

export const StatusBarAlignment = {
  Left: 1 as const,
  Right: 2 as const,
}

export const window = {
  createTreeView: () => ({ dispose: () => {} }),
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    command: "",
    show() {},
    dispose() {},
  }),
  showInformationMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
}

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, fallback?: T): T | undefined => fallback,
  }),
  onDidChangeConfiguration: () => new Disposable(),
}

export const commands = {
  registerCommand: () => new Disposable(),
}

// The VS Code API exposes many more members; the tests only touch the
// above, so we stop here. A consumer that reaches for an unmocked member
// will get `undefined` and fail loudly — which is the desired signal.
