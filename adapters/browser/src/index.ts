export type {
  BrowserAdapterHandle,
  BrowserAdapterStartOptions,
  BrowserAdapterInstance,
} from "./types.js"

export { toAdapterHandle } from "./providers/to-adapter-handle.js"
export type { AdapterHandleMeta } from "./providers/to-adapter-handle.js"
export { createProcessProvider } from "./providers/process-provider.js"
export type { FacadeProvider, ProcessProviderSpec } from "./providers/process-provider.js"
export type { FacadeLaunchOptions } from "./providers/facade-options.js"

export { camofoxAdapter } from "./adapters/camofox.js"
export { bureauAdapter, bureauProvider } from "./adapters/bureau.js"
export { chromiumAdapter, chromiumProvider } from "./adapters/chromium.js"

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
