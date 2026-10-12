import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Every file that registers ipcMain handlers, as one text: register.ts and
 * the domain modules it calls (src/main/ipc/handlers). Tests that look for a
 * channel's registration read this, so moving a handler between them is not
 * a failure.
 */
export function readIpcRegistrationSource(root = process.cwd()): string {
  const dir = join(root, 'src/main/ipc/handlers')
  const handlers = readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8'))
  return [readFileSync(join(root, 'src/main/ipc/register.ts'), 'utf8'), ...handlers].join('\n')
}
