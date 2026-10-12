/**
 * @vitest-environment jsdom
 */
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRovingTabIndex } from '@renderer/lib/a11y/useRovingTabIndex'

afterEach(() => {
  cleanup()
})

function RovingFixture({ loop = true }: { loop?: boolean }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const { tabIndexFor, setOptionRef, onContainerKeyDown } = useRovingTabIndex({
    count: 4,
    activeIndex,
    onActiveIndexChange: setActiveIndex,
    loop
  })
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- test harness proxies keydown to the hook
    <div onKeyDown={onContainerKeyDown}>
      <button type="button" ref={setOptionRef(0)} tabIndex={tabIndexFor(0)}>
        Zero
      </button>
      <button type="button" ref={setOptionRef(1)} tabIndex={tabIndexFor(1)} disabled>
        One
      </button>
      <button type="button" ref={setOptionRef(2)} tabIndex={tabIndexFor(2)} aria-disabled="true">
        Two
      </button>
      <button type="button" ref={setOptionRef(3)} tabIndex={tabIndexFor(3)}>
        Three
      </button>
    </div>
  )
}

describe('useRovingTabIndex disabled skipping', () => {
  it('skips disabled and aria-disabled options on arrows', () => {
    render(<RovingFixture />)
    const zero = screen.getByRole('button', { name: 'Zero' })
    const three = screen.getByRole('button', { name: 'Three' })
    zero.focus()
    // fireEvent returns false when the keydown was preventDefaulted (moved).
    expect(fireEvent.keyDown(zero, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(three)
  })

  it('lands Home and End on the first and last enabled options', () => {
    render(<RovingFixture />)
    const zero = screen.getByRole('button', { name: 'Zero' })
    const three = screen.getByRole('button', { name: 'Three' })
    three.focus()
    fireEvent.keyDown(three, { key: 'Home' })
    expect(document.activeElement).toBe(zero)
    fireEvent.keyDown(zero, { key: 'End' })
    expect(document.activeElement).toBe(three)
  })

  it('does not preventDefault when nothing moves without looping', () => {
    render(<RovingFixture loop={false} />)
    const three = screen.getByRole('button', { name: 'Three' })
    three.focus()
    // No enabled option past the end: focus stays and the key is not claimed.
    expect(fireEvent.keyDown(three, { key: 'ArrowDown' })).toBe(true)
    expect(document.activeElement).toBe(three)
  })
})
