export type {
  BrowserAdapterHandle,
  BrowserAdapterStartOptions,
  BrowserAdapterInstance,
} from "./types.js"

export { camofoxAdapter } from "./adapters/camofox.js"
export { bureauAdapter } from "./adapters/bureau.js"
export { chromiumAdapter } from "./adapters/chromium.js"

import { camofoxAdapter } from "./adapters/camofox.js"
import { bureauAdapter } from "./adapters/bureau.js"
import { chromiumAdapter } from "./adapters/chromium.js"
import type { BrowserAdapterHandle } from "./types.js"

export const browserAdapters: Record<string, BrowserAdapterHandle> = {
  camofox: camofoxAdapter,
  bureau: bureauAdapter,
  chromium: chromiumAdapter,
}

export function getBrowserAdapter(id: string): BrowserAdapterHandle | undefined {
  return browserAdapters[id]
}
