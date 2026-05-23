/**
 * Type sidecar for `mention-parser.mjs`. The implementation file is
 * vanilla JavaScript so runtime profiles can stamp its source into
 * Claude Code hooks at build time; this `.d.mts` keeps the TS-side
 * type contract crisp.
 */

export function textContainsMention(text: string, name: string): boolean
