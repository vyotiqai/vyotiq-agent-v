/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useState, type JSX } from 'react'
import { axe } from 'vitest-axe'
// `vitest-axe/matchers` re-exports types only, and the package's own augmentation
// targets the pre-1.0 `Vi` namespace: import the matcher from dist and declare it here.
import { toHaveNoViolations, type AxeMatchers } from 'vitest-axe/dist/matchers.js'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { ToastHost } from '@renderer/lib/ui/ToastHost'
import { pushToast, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'
import { ActionMenu } from '@renderer/lib/ui/ActionMenu'

declare module 'vitest' {
  // Vitest 5 merges custom matchers through Matchers; its parameters must match exactly.
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends AxeMatchers {}
}

expect.extend({ toHaveNoViolations })

beforeEach(() => {
  document.documentElement.setAttribute('lang', 'en')
  document.title = 'axe smoke'
  resetToastStoreForTests()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  resetToastStoreForTests()
})

function MenuFixture(): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <ActionMenu
      aria-label="Smoke menu"
      open={open}
      onOpenChange={setOpen}
      placement="down"
      items={[
        { id: 'one', label: 'First action', onSelect: () => undefined },
        { id: 'two', label: 'Second action', onSelect: () => undefined }
      ]}
      trigger={(props) => (
        <button
          ref={props.ref}
          type="button"
          aria-expanded={props['aria-expanded']}
          aria-controls={props['aria-controls']}
          aria-haspopup={props['aria-haspopup']}
          onClick={props.onClick}
        >
          Smoke menu
        </button>
      )}
    />
  )
}

describe('axe smoke', () => {
  // The `region` (landmark) rule is page structure, not component markup:
  // these fixtures render on a bare document.body with no app landmarks.
  const options = { rules: { region: { enabled: false } } }

  it('Dialog has no violations', async () => {
    render(
      <Dialog open onClose={() => undefined} title="Smoke dialog" useNativeDialog={false}>
        <p>Smoke body</p>
      </Dialog>
    )
    expect(await axe(document.body, options)).toHaveNoViolations()
  })

  it('ToastHost stack has no violations', async () => {
    pushToast('Smoke toast', 'info', 0)
    render(<ToastHost />)
    expect(await axe(document.body, options)).toHaveNoViolations()
  })

  it('ActionMenu has no violations', async () => {
    render(<MenuFixture />)
    expect(await axe(document.body, options)).toHaveNoViolations()
  })
})
