/**
 * @vitest-environment jsdom
 */
/**
 * The Home "Environment" panel listed four servers like this:
 *
 *   DeepWiki is not connected    The server is enabled but reported no connection.   [Manage]
 *   GitHub is not connected      The server is enabled but reported no connection.   [Manage]
 *   Context7 is not connected    The server is enabled but reported no connection.   [Manage]
 *   Notion is not connected      The server is enabled but reported no connection.   [Manage]
 *
 * One sentence for every cause, and the same two-hop route to the fix whether
 * the server wanted a sign-in, had timed out, or was still dialling. Main now
 * classifies the failure where the original error object still exists, so each
 * row can name its own cause and offer the control that resolves it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EnvironmentSection } from '@renderer/features/home/components/EnvironmentSection'

afterEach(cleanup)

const show = (
  mcpIssues: Parameters<typeof EnvironmentSection>[0]['mcpIssues'],
  handlers?: { onOpenMcpServer?: (id: string) => void; onRetryMcp?: () => void }
): void => {
  render(
    <EnvironmentSection
      providerIssue={null}
      mcpIssues={mcpIssues}
      onOpenMcpServer={handlers?.onOpenMcpServer ?? vi.fn()}
      onRetryMcp={handlers?.onRetryMcp ?? vi.fn()}
    />
  )
}

describe('the Environment panel', () => {
  it('asks for a sign-in rather than reporting a fault', () => {
    show([{ id: 'github', name: 'GitHub', error: 'Sign in required', errorKind: 'sign-in' }])

    expect(screen.getByText('Sign in to GitHub')).toBeTruthy()
    expect(screen.queryByText(/GitHub is not connected/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('shows the real reason a server could not be reached, and offers Retry', () => {
    const onRetryMcp = vi.fn()
    show(
      [
        {
          id: 'deepwiki',
          name: 'DeepWiki',
          error: 'Timed out reaching mcp.deepwiki.com — check your network or proxy, then retry.',
          errorKind: 'network'
        }
      ],
      { onRetryMcp }
    )

    expect(screen.getByText('DeepWiki could not be reached')).toBeTruthy()
    expect(screen.getByText(/Timed out reaching mcp\.deepwiki\.com/)).toBeTruthy()
    // The generic sentence is what every row used to say instead.
    expect(screen.queryByText(/reported no connection/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryMcp).toHaveBeenCalled()
  })

  it('sends a missing binary to Manage, because retrying cannot install one', () => {
    const onOpenMcpServer = vi.fn()
    show([{ id: 'git', name: 'Git', error: 'uvx was not found on PATH', errorKind: 'binary' }], {
      onOpenMcpServer
    })

    expect(screen.getByText('Git is not connected')).toBeTruthy()
    expect(screen.getByText('uvx was not found on PATH')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(onOpenMcpServer).toHaveBeenCalledWith('git')
  })

  it('renders nothing when there is nothing wrong', () => {
    const { container } = render(<EnvironmentSection providerIssue={null} mcpIssues={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
