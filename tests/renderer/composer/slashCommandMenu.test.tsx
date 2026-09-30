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

type MenuOverrides = Partial<{
  commands: SlashCommandDescriptor[]
  mcpServers: readonly SlashMcpServer[]
  loading: boolean
  listError: string | null
  anchorWidth: number
}>

function renderMenu(activeIndex = 0, overrides: MenuOverrides = {}) {
  const anchor = document.createElement('div')
  document.body.appendChild(anchor)
  const anchorRef = createRef<HTMLElement>()
  ;(anchorRef as { current: HTMLElement | null }).current = anchor
  if (overrides.anchorWidth != null) {
    anchor.getBoundingClientRect = () =>
      ({ top: 400, bottom: 460, left: 40, right: 40 + overrides.anchorWidth, width: overrides.anchorWidth, height: 60 }) as DOMRect
  }
  const onPick = vi.fn()
  const onActiveIndexChange = vi.fn()
  render(
    <SlashCommandMenu
      open
      commands={overrides.commands ?? commands}
      mcpServers={overrides.mcpServers ?? [linear]}
      activeIndex={activeIndex}
      onActiveIndexChange={onActiveIndexChange}
      onPick={onPick}
      anchorRef={anchorRef}
      loading={overrides.loading}
      listError={overrides.listError}
    />
  )
  const listbox = screen.getByRole('listbox', { name: 'Slash commands' })
  return { onPick, onActiveIndexChange, listbox, panel: listbox.closest('[data-slash-panel]')! }
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

  it('names the list and counts what it holds', () => {
    renderMenu()
    const header = screen.getByText('Slash commands').closest('div')!
    expect(header.classList.contains('shrink-0')).toBe(true)
    expect(header.textContent).toBe('Slash commands3 commands')

    cleanup()
    renderMenu(0, { commands: [commands[1]!] })
    expect(screen.getByText('1 command')).toBeTruthy()
  })

  it('pins the footer outside the scrolling list', () => {
    const { listbox, panel } = renderMenu(0)
    const footer = panel.querySelector('[data-slash-footer]')!
    expect(footer.classList.contains('shrink-0')).toBe(true)
    expect(footer.classList.contains('border-t')).toBe(true)
    expect(listbox.contains(footer)).toBe(false)
    expect(listbox.classList.contains('overflow-y-auto')).toBe(true)
    expect(listbox.classList.contains('min-h-0')).toBe(true)
  })

  it('tracks the composer width between its bounds, then stops growing', () => {
    const narrow = renderMenu(0, { anchorWidth: 320 }).panel as HTMLElement
    expect(narrow.style.width).toBe('320px')

    cleanup()
    const wide = renderMenu(0, { anchorWidth: 1200 }).panel as HTMLElement
    expect(wide.style.width).toBe('420px')

    cleanup()
    const tiny = renderMenu(0, { anchorWidth: 120 }).panel as HTMLElement
    expect(tiny.style.width).toBe('260px')
  })

  it('tells loading, error and no-match apart at a glance', () => {
    const loading = renderMenu(0, { commands: [], loading: true })
    expect(loading.listbox.getAttribute('data-slash-state')).toBe('loading')
    expect(loading.listbox.getAttribute('aria-busy')).toBe('true')
    expect(within(loading.listbox).getByRole('status').textContent).toBe('Loading commands…')

    cleanup()
    const failed = renderMenu(0, { commands: [], listError: 'slash list unavailable' })
    expect(failed.listbox.getAttribute('data-slash-state')).toBe('error')
    expect(within(failed.listbox).getByRole('alert').textContent).toBe('slash list unavailable')
    expect(within(failed.listbox).queryByText('No matches')).toBeNull()

    cleanup()
    const empty = renderMenu(0, { commands: [] })
    expect(empty.listbox.getAttribute('data-slash-state')).toBe('empty')
    expect(within(empty.listbox).getByText('No matches')).toBeTruthy()
    expect(within(empty.listbox).getByText('Keep typing to filter commands.')).toBeTruthy()
    expect(empty.panel.querySelector('[data-slash-footer]')!.textContent).toBe('Nothing to select')
  })

  it('marks a busy refresh over existing rows without emptying the list', () => {
    const { listbox, panel } = renderMenu(0, { loading: true })
    expect(listbox.getAttribute('data-slash-state')).toBe('results')
    expect(within(listbox).getAllByRole('option')).toHaveLength(3)
    expect(within(listbox).queryByText('Loading commands…')).toBeNull()
    expect(panel.textContent).toContain('3 commands')
  })
})
