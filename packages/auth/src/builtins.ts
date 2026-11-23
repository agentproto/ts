/**
 * Builtin auth-provider manifests. The kit ships none: the registry starts
 * empty and a host declares its own provider by parsing its `.md` manifest
 * with `parseAuthProviderManifest` (or building one with
 * `defineAuthProvider`) and registering it via `registerAuthProvider`.
 */

import type { AuthProviderHandle } from "./types.js"

export const BUILTIN_AUTH_PROVIDERS: readonly AuthProviderHandle[] = []
