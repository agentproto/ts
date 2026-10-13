/**
 * Error-text hygiene for provider `exec` failures. SDKs (e2b) echo the whole
 * shelled command into their error message — for a 9 KB inline script that is
 * unreadable, and any secret placed in the command leaks into logs/transcripts.
 */

/** Characters of a command kept in an error message. */
export const EXEC_ERROR_COMMAND_MAX_CHARS = 200

/** `command` cut to {@link EXEC_ERROR_COMMAND_MAX_CHARS} with a `…(N chars)` marker. */
export function shortenCommand(command: string, max = EXEC_ERROR_COMMAND_MAX_CHARS): string {
  if (command.length <= max) return command
  return `${command.slice(0, max)}…(${command.length} chars)`
}

/** Replace every verbatim occurrence of `command` in `message` with its
 *  shortened form. A short command is left alone (nothing to gain). */
export function scrubCommandFromMessage(message: string, command: string): string {
  if (command.length <= EXEC_ERROR_COMMAND_MAX_CHARS || command.length === 0) return message
  return message.split(command).join(shortenCommand(command))
}
