/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { McpServerCard } from '@renderer/features/marketplace/McpServerCard'
import type { McpServer, McpServerStatus } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const gmailServer: McpServer = {
  id: 'gmail',
  name: 'Gmail',
  transport: 'http',
  url: 'https://gmailmcp.googleapis.com/mcp/v1',
  enabled: true
}

const githubServer: McpServer = {
  id: 'github',
  name: 'GitHub',
  transport: 'http',
  url: 'https://api.githubcopilot.com/mcp/',
  enabled: true
}

const disconnected: McpServerStatus = {
  id: 'x',
  name: 'x',
  enabled: true,
  connected: false,
  toolCount: 0
}

/**
 * Raw connection config lives behind Advanced now, so these assertions open it
 * first. Connect and the status line stay in the always-visible summary row.
 */
function openAdvanced(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Advanced$/i }))
}

describe('McpServerCard HTTP auth', () => {
  it('disables Google Sign in until client ID and stored secret exist', () => {
    render(
      <McpServerCard
        server={gmailServer}
        status={{ ...disconnected, id: 'gmail', name: 'Gmail' }}
        onUpdate={async () => true}
        onRemove={() => undefined}
      />
    )
    openAdvanced()
    expect(
      (screen.getByRole('button', { name: /^Sign in with OAuth$/i }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(screen.getByLabelText(/OAuth client ID/i)).toBeTruthy()
    expect(screen.getByLabelText(/OAuth client secret/i)).toBeTruthy()
    expect(screen.getByLabelText(/Bearer token/i)).toBeTruthy()
    expect(screen.getByLabelText(/OAuth redirect URI/i)).toBeTruthy()
  })

  it('enables Google Sign in when shared client ID and stored secret exist', () => {
    render(
      <McpServerCard
        server={gmailServer}
        status={{
          ...disconnected,
          id: 'gmail',
          name: 'Gmail',
          hasOAuthClientSecret: true
        }}
        googleMcpClientId="123.apps.googleusercontent.com"
        onUpdate={async () => true}
        onRemove={() => undefined}
      />
    )
    openAdvanced()
    expect(
      (screen.getByRole('button', { name: /^Sign in with OAuth$/i }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('enables GitHub Sign in without a client ID', () => {
    render(
      <McpServerCard
        server={githubServer}
        status={{ ...disconnected, id: 'github', name: 'GitHub' }}
        onUpdate={async () => true}
        onRemove={() => undefined}
        onOpenConnect={() => undefined}
      />
    )
    // Connect is reachable without expanding anything.
    expect(screen.getByRole('button', { name: /^Connect$/i })).toBeTruthy()
    openAdvanced()
    expect(
      (screen.getByRole('button', { name: /^Sign in with OAuth$/i }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('keeps raw config collapsed until Advanced is opened', () => {
    render(
      <McpServerCard
        server={githubServer}
        status={{ ...disconnected, id: 'github', name: 'GitHub' }}
        onUpdate={async () => true}
        onRemove={() => undefined}
        onOpenConnect={() => undefined}
      />
    )
    const panel = document.getElementById('mcp-advanced-github')
    const toggle = screen.getByRole('button', { name: /^Advanced$/i })
    expect(panel?.hasAttribute('hidden')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    openAdvanced()
    expect(panel?.hasAttribute('hidden')).toBe(false)
    expect(
      screen.getByRole('button', { name: /^Hide advanced$/i }).getAttribute('aria-expanded')
    ).toBe('true')
  })

  it('offers install and locate actions for a missing stdio binary', () => {
    render(
      <McpServerCard
        server={{
          id: 'git',
          name: 'Git',
          transport: 'stdio',
          command: 'uvx',
          requires: ['uv'],
          enabled: true
        }}
        status={{
          ...disconnected,
          id: 'git',
          name: 'Git',
          error: 'uvx (uv) was not found on PATH, so this MCP server cannot start.',
          missingBinary: 'uvx',
          missingBinaryInstallUrl: 'https://docs.astral.sh/uv/getting-started/installation/'
        }}
        onUpdate={async () => true}
        onRemove={() => undefined}
      />
    )
    // The fix is offered without expanding anything.
    expect(screen.getByRole('button', { name: /Install uvx/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Locate binary/i })).toBeTruthy()
  })
})
