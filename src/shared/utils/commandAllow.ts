/**
 * "Always allow" for the terminal tool is per command, not per tool: approving
 * `pnpm vitest run a.test.ts` remembers `pnpm vitest`, and later `pnpm vitest …`
 * runs without asking. A whole-tool allow would let every future command
 * through, which is not what anyone agreeing to one command means.
 *
 * Only a simple command can be scoped this way. One that chains, pipes,
 * redirects or substitutes (`&&`, `;`, `|`, `>`, `$(…)`, backticks, a second
 * line) could hide anything behind an allowed prefix, so it is never matched
 * and never offered "Always allow".
 */

/** The prefix stored for a terminal command: `terminal:<program> [subcommand]`. */
export const TERMINAL_ALLOW_PREFIX = 'terminal:'

/** Shell syntax that runs, feeds or rewires more than the one command it starts with. */
const COMPOUND = /[;&|<>`\r\n]|\$\(/

/** `FOO=bar pnpm test` — leading env assignments are not the program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A word that reads as a subcommand (`vitest`, `status`, `run:e2e`), not a path or flag. */
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9._:-]*$/

function words(command: string): string[] | null {
  const trimmed = command.trim()
  if (!trimmed || COMPOUND.test(trimmed)) return null
  const tokens = trimmed.split(/\s+/)
  let i = 0
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++
  const rest = tokens.slice(i)
  return rest.length > 0 ? rest : null
}

/**
 * What "Always allow" would remember for this command — `pnpm vitest`,
 * `git status`, `ls` — or null when it cannot be scoped safely.
 */
export function commandAllowPrefix(command: string): string | null {
  const tokens = words(command)
  if (!tokens) return null
  const program = tokens[0]!
  const sub = tokens[1]
  return sub && SUBCOMMAND.test(sub) ? `${program} ${sub}` : program
}

export function commandAllowKey(prefix: string): string {
  return `${TERMINAL_ALLOW_PREFIX}${prefix}`
}

/** The command a stored allow names, or null for any other entry. */
export function commandFromAllowKey(key: string): string | null {
  return key.startsWith(TERMINAL_ALLOW_PREFIX) ? key.slice(TERMINAL_ALLOW_PREFIX.length) : null
}

/** True when `command` is a simple command starting with the allowed words. */
export function commandMatchesAllow(command: string, prefix: string): boolean {
  const tokens = words(command)
  const allowed = prefix.trim().split(/\s+/).filter(Boolean)
  if (!tokens || allowed.length === 0 || tokens.length < allowed.length) return false
  return allowed.every((word, i) => tokens[i] === word)
}

/** The command in a terminal call's arguments, when there is one. */
export function terminalCommandOf(args: Record<string, unknown> | undefined | null): string | null {
  const command = args?.command
  return typeof command === 'string' && command.trim() ? command : null
}
