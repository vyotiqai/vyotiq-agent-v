const { app, safeStorage } = require('electron')
const { readFileSync } = require('fs')
const { join } = require('path')
const { spawn } = require('child_process')

const userData = process.env.VYOTIQ_USER_DATA
if (userData) app.setPath('userData', userData)

app.whenReady().then(() => {
  const fail = (code) => {
    process.stderr.write(`LIVE_DECRYPT_FAIL ${code}\n`)
    app.exit(2)
  }
  if (!safeStorage.isEncryptionAvailable()) return fail('encryption_unavailable')
  let secrets
  try {
    secrets = JSON.parse(readFileSync(join(app.getPath('userData'), 'secrets.json'), 'utf8'))
  } catch {
    return fail('secrets_unreadable')
  }
  const blob = secrets.openrouter
  if (typeof blob !== 'string' || !blob) return fail('no_openrouter_blob')
  let key
  try {
    key = safeStorage.decryptString(Buffer.from(blob, 'base64')).trim()
  } catch {
    return fail('decrypt_error')
  }
  if (!key) return fail('empty_key')
  const child = spawn(
    process.env.LIVE_PNPM || 'pnpm',
    ['exec', 'vitest', 'run', 'tests/main/unit/compactionLossLive.test.ts'],
    {
      cwd: process.env.LIVE_CWD,
      env: {
        ...process.env,
        OPENROUTER_API_KEY: key,
        OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'stealth/ox-alpha'
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: true,
      windowsHide: true
    }
  )
  child.on('exit', (code) => app.exit(code ?? 1))
})
