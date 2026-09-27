/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Dialog } from '@renderer/lib/a11y'
import { Menu } from '@renderer/lib/ui'
import { resetFloatingLayersForTests } from '@renderer/lib/hooks/floatingLayers'

afterEach(() => {
  cleanup()
  resetFloatingLayersForTests()
})

function MenuInDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('a')
  return (
    <Dialog open onClose={onClose} title="Settings">
      <Menu
        aria-label="Branch"
        value={value}
        onChange={setValue}
        placement="down"
        options={[
          { value: 'a', label: 'main' },
          { value: 'b', label: 'feat/x' }
        ]}
      />
    </Dialog>
  )
}

describe('a menu inside a dialog', () => {
  it('takes the first Escape, and the next one closes the dialog', async () => {
    const onClose = vi.fn()
    render(<MenuInDialog onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Branch/ }))
    const option = await screen.findByRole('option', { name: 'feat/x' })

    await act(async () => {
      fireEvent.keyDown(option, { key: 'Escape' })
    })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens above the dialog: menus stack over dialogs and drawers, under toasts and tooltips', () => {
    const css = readFileSync(join(__dirname, '../../../src/renderer/src/styles.css'), 'utf8')
    const z = (name: string): number => {
      const match = new RegExp(`--z-${name}:\\s*(\\d+)`).exec(css)
      if (!match) throw new Error(`no --z-${name}`)
      return Number(match[1])
    }
    expect(z('dropdown')).toBeGreaterThan(z('drawer'))
    expect(z('dropdown')).toBeLessThan(z('toast'))
    expect(z('toast')).toBeLessThan(z('tooltip'))
  })
})
