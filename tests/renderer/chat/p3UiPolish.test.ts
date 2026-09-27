/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildComposerSendProps,
  deriveChatErrorSurfaces
} from '@renderer/features/chat/hooks/composerShared'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import { resolveEffectiveSettings } from '@shared/effectiveSettings'

const root = join(__dirname, '../../../src/renderer/src')

describe('P3 surfaceKey + composer shared hooks', () => {
  it('keys the SessionChatColumn surface by workspace and epoch (no activeRunId)', () => {
    const column = readFileSync(join(root, 'features/chat/SessionChatColumn.tsx'), 'utf8')

    expect(column).toMatch(
      /surfaceKey = `\$\{workspacePath \?\? 'none'\}:\$\{chatSurfaceEpoch\}`/
    )
    expect(column).not.toMatch(/activeRunId \?\? 'draft'/)
  })

  it('deriveChatErrorSurfaces clears banner when transcript has run_error', () => {
    const surfaces = deriveChatErrorSurfaces(true, {
      error: 'composer boom',
      errorCode: 'PROVIDER_NETWORK'
    })
    expect(surfaces.chatBannerError).toBeNull()
    expect(surfaces.turnFailed).toBe(true)

    const clean = deriveChatErrorSurfaces(false, {
      error: 'composer boom',
      errorCode: 'PROVIDER_NETWORK'
    })
    expect(clean.chatBannerError).toBe('composer boom')
  })

  it('deriveChatErrorSurfaces treats auth/plan/billing failures as permanent', () => {
    expect(
      deriveChatErrorSurfaces(false, { error: 'bad key', errorCode: 'PROVIDER_AUTH' }).turnFailed
    ).toBe(false)
    expect(
      deriveChatErrorSurfaces(false, { error: 'no credits', errorCode: 'PROVIDER_BILLING' })
        .turnFailed
    ).toBe(false)
  })

  it('buildComposerSendProps mirrors shared dock fields', () => {
    const chatSettings = resolveEffectiveSettings(DEFAULT_SETTINGS, null)
    const props = buildComposerSendProps({
      provider: 'openai',
      model: 'gpt-4.1',
      running: false,
      hasWorkspace: true,
      workspacePath: '/ws',
      onProviderModel: () => undefined,
      chatSettings,
      onChatSettingsChange: () => undefined,
      onSend: () => true,
      secrets: emptySecretStatus(),
      bannerError: null,
      secondaryBannerError: null,
      activeRunId: 'run-1'
    })
    expect(props.disabled).toBe(false)
    expect(props.onRetryNetwork).toBeUndefined()
    expect(props.bannerError).toBeNull()
    expect(props.activeRunId).toBe('run-1')
  })

  it('App wires pane compact + changes handlers into SessionChatColumn', () => {
    const app = readFileSync(join(root, 'app/App.tsx'), 'utf8')
    expect(app).toMatch(/onCompactContext=\{paneCompact\}/)
    expect(app).toMatch(/onOpenChanges=\{onOpenChanges\}/)
    expect(app).toMatch(/onOpenWorkspaceFile=\{onOpenWorkspaceFile\}/)
  })

  it('SessionChatColumn puts onOpenWorkspaceFile on the run session', () => {
    const column = readFileSync(join(root, 'features/chat/SessionChatColumn.tsx'), 'utf8')
    expect(column).toMatch(/onOpenWorkspaceFile/)
    expect(column).toMatch(/onOpenWorkspaceFile\s*\n\s*\}\)/)
  })
})
