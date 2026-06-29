/**
 * Build-time stub for `react-devtools-core`.
 *
 * Ink statically `import`s react-devtools-core in its `devtools.js`, but only
 * *invokes* it when `DEV=true`. Since we bundle the whole Ink stack into the
 * CLI binary (so it can't resolve react@19 from a host monorepo), that static
 * import would otherwise hard-fail at module load — react-devtools-core is a
 * dev-only dependency that isn't installed in production. Aliasing it to this
 * no-op keeps the import resolvable; the function is never called outside DEV.
 */
export function connectToDevTools(): void {
  // no-op — devtools are never attached in the bundled CLI
}

export function connectWithCustomMessagingProtocol(): void {
  // no-op
}

export default { connectToDevTools, connectWithCustomMessagingProtocol }
