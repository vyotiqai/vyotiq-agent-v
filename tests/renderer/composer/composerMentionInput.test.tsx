/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle
} from '@renderer/features/chat/components/composer/ComposerMentionInput'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'

describe('ComposerMentionInput sync', () => {
  it('clears orphan DOM nodes when controlled value becomes empty', () => {
    const ref = createRef<ComposerMentionInputHandle>()
    const onChange = vi.fn()
    const onKeyDown = vi.fn()
    const { rerender } = render(
      <ComposerMentionInput
        ref={ref}
        value="orphan text"
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    )

    expect(ref.current?.el?.textContent).toBe('orphan text')

    rerender(
      <ComposerMentionInput ref={ref} value="" onChange={onChange} onKeyDown={onKeyDown} />
    )

    expect(ref.current?.el?.textContent ?? '').toBe('')
  })

  it('hides placeholder while composing', () => {
    const ref = createRef<ComposerMentionInputHandle>()
    render(
      <ComposerMentionInput
        ref={ref}
        value=""
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        placeholder="Ask anything…"
      />
    )

    expect(screen.getByText('Ask anything…')).toBeTruthy()
    expect(screen.getByText('Ask anything…').className).toMatch(/\bflex\b/)
    expect(screen.getByText('Ask anything…').className).toMatch(/\bitems-center\b/)

    const el = ref.current?.el
    expect(el).toBeTruthy()
    act(() => {
      el!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })

    expect(screen.queryByText('Ask anything…')).toBeNull()
  })

  it('forwards pasted files and inserts plain text in one pass', () => {
    const onPasteFiles = vi.fn()
    const onChange = vi.fn()
    const file = new File(['png'], 'shot.png', { type: 'image/png' })
    render(
      <ComposerMentionInput
        value=""
        onChange={onChange}
        onKeyDown={vi.fn()}
        onPasteFiles={onPasteFiles}
      />
    )
    const el = screen.getByRole('combobox', { name: 'Instruction' })
    fireEvent.paste(el, {
      clipboardData: {
        files: [file],
        items: [],
        getData: (type: string) => (type === 'text/plain' ? 'hello' : '')
      }
    })
    expect(onPasteFiles).toHaveBeenCalledTimes(1)
    expect(onPasteFiles.mock.calls[0]![0][0]).toBe(file)
    expect(el.textContent).toBe('hello')
    expect(onChange).toHaveBeenCalledWith('hello')
  })

  it('inserts multi-line paste as text nodes and <br>, no execCommand', () => {
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: exec
    })
    const onChange = vi.fn()
    render(<ComposerMentionInput value="" onChange={onChange} onKeyDown={vi.fn()} />)
    const el = screen.getByRole('combobox', { name: 'Instruction' })
    fireEvent.paste(el, {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) => (type === 'text/plain' ? 'line1\nline2' : '')
      }
    })
    expect(el.textContent).toBe('line1line2')
    expect(el.querySelectorAll('br')).toHaveLength(1)
    expect(onChange).toHaveBeenCalledWith('line1\nline2')
    expect(exec).not.toHaveBeenCalled()
  })

  it('reports a serialized caret offset after paste without cloning the DOM', () => {
    const ref = createRef<ComposerMentionInputHandle>()
    render(
      <ComposerMentionInput ref={ref} value="" onChange={vi.fn()} onKeyDown={vi.fn()} />
    )
    const el = screen.getByRole('combobox', { name: 'Instruction' })
    fireEvent.paste(el, {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) => (type === 'text/plain' ? 'abcdef' : '')
      }
    })
    expect(ref.current?.getSelectionStart()).toBe(6)
  })

  it('draws a chip with its menu icon as SVG, and a file chip with its file-type image', () => {
    const ref = createRef<ComposerMentionInputHandle>()
    const value = `${mentionMarker({ kind: 'slash', slashKind: 'skill', trigger: 'code-review' })} and ${mentionMarker({ kind: 'file', path: 'src/a.ts' })}`
    render(<ComposerMentionInput ref={ref} value={value} onChange={vi.fn()} onKeyDown={vi.fn()} />)
    const chips = ref.current!.el!.querySelectorAll<HTMLElement>('[data-mention]')
    expect(chips).toHaveLength(2)
    const glyph = chips[0]!.querySelector('svg')
    expect(glyph).toBeTruthy()
    expect(glyph!.getAttribute('data-chip-glyph')).toBe('skill')
    expect(chips[0]!.textContent).toBe('code-review')
    expect(chips[1]!.querySelector('img')).toBeTruthy()
    // No text glyphs stand in for icons any more.
    expect(ref.current!.el!.textContent).not.toMatch(/[✦⬡⎇◎▤◇]/)
  })
})
