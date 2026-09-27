/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TerminalBody } from '@renderer/features/chat/toolUi/bodies/TerminalBody'
import { McpBody } from '@renderer/features/chat/toolUi/bodies/McpBody'
import { DeleteBody } from '@renderer/features/chat/toolUi/bodies/DeleteBody'
import { WebFetchBody } from '@renderer/features/chat/toolUi/bodies/WebFetchBody'
import { wrapFamilyShell } from '@renderer/features/chat/toolUi/shells'
import { Chip, CopyButton } from '@renderer/features/chat/toolUi/primitives'
import { toolIconName } from '@renderer/features/chat/toolUi/meta'
import { getToolHeaderMeta } from '@renderer/features/chat/toolUi/registry'
import type { UiToolRow } from '@shared/transcript'

afterEach(cleanup)

function tool(overrides: Partial<UiToolRow> & Pick<UiToolRow, 'name'>): UiToolRow {
  return { id: 't1', summary: '', status: 'done', ...overrides }
}

const terminal = tool({
  name: 'terminal',
  argsPreview: JSON.stringify({ command: 'pnpm lint' }),
  content: 'cwd: /repo\nshell: bash\n---\nAll files pass.'
})

describe('TerminalBody', () => {
  it('does not repeat the command the record card heads it with', () => {
    const { container } = render(<TerminalBody tool={terminal} />)
    expect(container.textContent).not.toContain('$ pnpm lint')
    expect(container.textContent).toContain('All files pass.')
  })

  it('keeps the command on a lookup row, which clips it', () => {
    const { container } = render(<TerminalBody tool={terminal} inGroup />)
    expect(container.textContent).toContain('$ pnpm lint')
  })

  it('shows keyboard focus inside the clipping card', () => {
    render(<TerminalBody tool={terminal} />)
    const region = screen.getByRole('region', { name: 'Terminal output' })
    expect(region.className).toContain('focus-visible:ring-inset')
  })
})

describe('McpBody', () => {
  it('puts one colour on an error result, never two', () => {
    const { container } = render(
      <McpBody
        tool={tool({
          name: 'mcp__github__get_issue',
          status: 'fail',
          content: 'Error: not found'
        })}
      />
    )
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.classList.contains('text-danger')).toBe(true)
    expect(pre!.classList.contains('text-secondary')).toBe(false)
    expect(pre!.classList.contains('bg-sunken')).toBe(true)
  })
})

describe('DeleteBody', () => {
  it('keeps the trash icon quiet when the delete worked', () => {
    const { container } = render(
      <DeleteBody
        tool={tool({
          name: 'delete',
          argsPreview: JSON.stringify({ path: 'dist', recursive: true }),
          content: 'Deleted dist (recursive)'
        })}
      />
    )
    const icon = container.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon!.getAttribute('class')).toContain('text-muted')
    expect(icon!.getAttribute('class')).not.toContain('text-danger')
  })

  it('adds no danger rule of its own around a delete body', () => {
    const { container } = render(<>{wrapFamilyShell('delete', <p>body</p>)}</>)
    expect(container.innerHTML).not.toContain('border-danger')
  })
})

describe('WebFetchBody', () => {
  it('sizes its markdown through props, not an ignored wrapper', () => {
    const { container } = render(
      <WebFetchBody
        inGroup
        tool={tool({
          name: 'web_fetch',
          argsPreview: JSON.stringify({ url: 'https://example.com' }),
          content: '# Example\n\nSome page text.'
        })}
      />
    )
    const root = container.querySelector('.markdown-body')
    expect(root).not.toBeNull()
    expect(root!.classList.contains('text-caption')).toBe(true)
    expect(root!.classList.contains('text-secondary')).toBe(true)
  })
})

describe('toolUi primitives and icons', () => {
  it('never draws the record as a chatbot', () => {
    for (const name of ['spawn_agent_instance', 'switch_mode', 'build_tool']) {
      expect(toolIconName(name)).not.toBe('bot')
      expect(getToolHeaderMeta({ id: 't', name, summary: 'x', status: 'done' }).icon).not.toBe('bot')
    }
  })

  it('draws a chip at a scale size without an invented tint', () => {
    const { container } = render(<Chip>main</Chip>)
    const chip = container.firstElementChild!
    expect(chip.classList.contains('text-caption')).toBe(true)
    expect(chip.className).not.toMatch(/\/\d/)
  })

  it('copies from an icon button with a label and a focus ring', () => {
    render(<CopyButton text="src/a.ts" />)
    const button = screen.getByRole('button', { name: 'Copy' })
    expect(button.className).toContain('focus-visible:vy-focus-ring')
    expect(button.textContent).toBe('')
  })
})
