/** Thrown by `loadAppHandle` and its helpers (`loadAppBundledTools`, …) on
 *  any disk/parse/validation failure while reading an app bundle off disk. */
export class AppLoadError extends Error {
  constructor(message: string) {
    super(`loadAppHandle: ${message}`)
    this.name = "AppLoadError"
  }
}
