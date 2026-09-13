/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
    expect(
      (screen.getByRole('button', { name: /^Sign in with OAuth$/i }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(screen.getByRole('button', { name: /^Connect$/i })).toBeTruthy()
  })
})
