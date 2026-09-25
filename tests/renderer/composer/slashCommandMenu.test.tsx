/**
 * @vitest-environment jsdom
 */
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SlashCommandDescriptor, SlashMcpServer } from '@shared/ipc'
import { SlashCommandMenu } from '@renderer/features/chat/components/composer/SlashCommandMenu'

afterEach(() => {
  cleanup()
})

const commands: SlashCommandDescriptor[] = [
  {
    id: 'skill:write-tests',
    trigger: 'write-tests',
    label: 'Write tests',
    description: 'Cover a change with focused tests. Reads the diff first',
    kind: 'skill',
    group: 'Skills',
    availability: 'ready',
    packageId: 'write-tests'
  },
  {
    id: 'builtin:goal',
    trigger: 'goal',
    label: 'Set goal',
    description: 'Keep working toward an objective. /goal pause, resume or complete it',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'mcp:mcp__linear__create_issue',
    trigger: 'linear-create-issue',
    label: 'Create issue',
    description: 'Create a new issue in Linear',
    kind: 'mcp',
    group: 'MCP',
    availability: 'disconnected',
    mcpServerId: 'linear',
    mcpToolName: 'create_issue'
  }
]

const linear: SlashMcpServer = {
  id: 'linear',
  name: 'Linear',
  iconUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
  iconMono: true
}

function renderMenu(activeIndex = 0) {
  const anchor = document.createElement('div')
  document.body.appendChild(anchor)
  const anchorRef = createRef<HTMLElement>()
  ;(anchorRef as { current: HTMLElement | null }).current = anchor
  const onPick = vi.fn()
  const onActiveIndexChange = vi.fn()
  render(
    <SlashCommandMenu
      open
      commands={commands}
      mcpServers={[linear]}
      activeIndex={activeIndex}
      onActiveIndexChange={onActiveIndexChange}
      onPick={onPick}
      anchorRef={anchorRef}
    />
  )
  return { onPick, onActiveIndexChange, listbox: screen.getByRole('listbox', { name: 'Slash commands' }) }
}

describe('SlashCommandMenu', () => {
  it('groups rows under quiet labels, MCP tools under their server', () => {
    const { listbox } = renderMenu()
    const groups = within(listbox).getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent)).toEqual([
      'Skills',
      'Commands',
      'Linear'
    ])
    const tool = within(groups[2]!).getByRole('option', { name: 'Create issue · /linear-create-issue' })
    expect(tool.textContent).toContain('create_issue')
    expect(tool.textContent).toContain('Linear MCP')
    // Not connected: the row says what accepting it will do.
    expect(tool.textContent).toContain('Connect')
    // The server's own mark, in the text colour.
    expect(tool.querySelector('[data-brand-mask]')).not.toBeNull()
  })

  it('fills only the active row, with no hover class left to fight it', () => {
    renderMenu(1)
    const goal = screen.getByRole('option', { name: 'Set goal · /goal' })
    const skill = screen.getByRole('option', { name: 'Write tests · /write-tests' })
    expect(goal.getAttribute('aria-selected')).toBe('true')
    expect(goal.classList.contains('bg-surface-2')).toBe(true)
    expect(goal.classList.contains('hover:bg-surface')).toBe(false)
    expect(skill.classList.contains('bg-surface-2')).toBe(false)
    expect(skill.classList.contains('hover:bg-surface')).toBe(true)
  })

  it('describes the active row in the footer, with what accepting it does', () => {
    renderMenu(0)
    const footer = screen.getByText(/Tab to insert/).closest('p')!
    expect(footer.textContent).toBe(
      'write-tests — Cover a change with focused tests. Reads the diff first. Tab to insert · runs with this instruction'
    )
  })

  it('follows the pointer, and picks on click', () => {
    const { onPick, onActiveIndexChange } = renderMenu(0)
    const goal = screen.getByRole('option', { name: 'Set goal · /goal' })
    fireEvent.mouseEnter(goal)
    expect(onActiveIndexChange).toHaveBeenCalledWith(1)
    expect(screen.getByText(/runs when you send/).closest('p')!.textContent).toContain('/goal — Keep working toward an objective.')
    fireEvent.click(goal)
    expect(onPick).toHaveBeenCalledWith(commands[1])
  })
})
