import { describe, expect, it } from 'vitest'
import { resourceTextDrifted } from '@main/marketplace/resourceDrift'

const manifestLf = '{\n  "id": "github",\n  "version": "1.0.0"\n}\n'
const manifestCrlf = manifestLf.replace(/\n/g, '\r\n')

describe('resourceTextDrifted', () => {
  it('treats identical text as unchanged', () => {
    expect(resourceTextDrifted(manifestLf, manifestLf)).toBe(false)
  })

  it('ignores CRLF vs LF — a packaged CRLF copy must not fight a dev LF checkout', () => {
    expect(resourceTextDrifted(manifestLf, manifestCrlf)).toBe(false)
    expect(resourceTextDrifted(manifestCrlf, manifestLf)).toBe(false)
  })

  it('ignores bare CR line endings too', () => {
    expect(resourceTextDrifted(manifestLf, manifestLf.replace(/\n/g, '\r'))).toBe(false)
  })

  it('still reports real content changes, whatever the line endings', () => {
    const bumped = manifestCrlf.replace('1.0.0', '1.1.0')
    expect(resourceTextDrifted(bumped, manifestLf)).toBe(true)
    expect(resourceTextDrifted(manifestLf, bumped)).toBe(true)
  })

  it('reports a missing trailing newline as drift (content, not encoding)', () => {
    expect(resourceTextDrifted(manifestLf.trimEnd(), manifestLf)).toBe(true)
  })
})
