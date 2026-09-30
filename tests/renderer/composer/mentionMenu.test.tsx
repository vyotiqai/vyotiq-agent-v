/**
 * @vitest-environment jsdom
 */
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fileIconUrl, folderIconUrl } from '@renderer/lib/fileIcons'
import { MentionMenu } from '@renderer/features/chat/components/composer/MentionMenu'
import type {
  MentionMenuItem,
  MentionMenuView
} from '@renderer/features/chat/components/composer/mentionModel'

afterEach(() => {
  cleanup()
})

const FILE_PATH = 'src/renderer/src/features/chat/components/composer/MentionMenu.tsx'
const FOLDER_PATH = 'src/renderer/src/features/chat/components/composer'

const fileRow: MentionMenuItem = {
  id: `file:${FILE_PATH}`,
  kind: 'file',
  path: FILE_PATH,
  label: 'MentionMenu.tsx',
  subtitle: 'src/renderer/src/features/chat/components/composer'
}

const folderRow: MentionMenuItem = {
  id: `folder:${FOLDER_PATH}`,
  kind: 'folder',
  path: FOLDER_PATH,
  label: 'composer',
  subtitle: 'src/renderer/src/features/chat/components'
}

const filesNav: MentionMenuItem = {
  id: 'files',
  kind: 'nav',
  view: 'files',
  label: 'Files and folders'
}

const chatsNav: MentionMenuItem = {
  id: 'chats',
  kind: 'nav',
  view: 'chats',
  label: 'Past tasks'
}

const rootItems: MentionMenuItem[] = [
  {
    id: 'branch',
    kind: 'branch',
    label: 'Branch diff',
    subtitle: 'uncommitted changes'
  },
  fileRow,
  filesNav,
  chatsNav
]

type MenuOverrides = Partial<{
  view: MentionMenuView
  items: MentionMenuItem[]
  query: string
  activeIndex: number
  loading: boolean
  error: string | null
  anchorWidth: number
}>

function renderMenu(overrides: MenuOverrides = {}) {
  const anchor = document.createElement('div')
  document.body.appendChild(anchor)
  const anchorRef = createRef<HTMLElement>()
  ;(anchorRef as { current: HTMLElement | null }).current = anchor
  if (overrides.anchorWidth != null) {
    const width = overrides.anchorWidth
    anchor.getBoundingClientRect = () =>
      ({ top: 400, bottom: 460, left: 40, right: 40 + width, width, height: 60 }) as DOMRect
  }
  const onPick = vi.fn()
  const onActiveIndexChange = vi.fn()
  render(
    <MentionMenu
      open
      view={overrides.view ?? 'root'}
      items={overrides.items ?? rootItems}
      query={overrides.query ?? ''}
      activeIndex={overrides.activeIndex ?? 0}
      onActiveIndexChange={onActiveIndexChange}
      onPick={onPick}
      anchorRef={anchorRef}
      loading={overrides.loading}
      error={overrides.error}
    />
  )
  const listbox = screen.getByRole('listbox', { name: 'Mentions' })
  return { onPick, onActiveIndexChange, listbox, panel: listbox }
}

/** The panel element that carries the state hook (the listbox root). */
function footer(listbox: HTMLElement): HTMLElement {
  return listbox.querySelector('[data-mention-footer]') as HTMLElement
}

describe('MentionMenu', () => {
  it('groups the root list under quiet labels', () => {
    const { listbox } = renderMenu()
    const groups = within(listbox).getAllByRole('group')
    expect(
      groups.map((g) => {
        const id = g.getAttribute('aria-labelledby')
        return id ? document.getElementById(id)?.textContent : null
      })
    ).toEqual(['Context', 'Recent files', 'Browse'])
  })

  it('picks a browse nav row', () => {
    const { onPick } = renderMenu()
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Files and folders' }))
    expect(onPick).toHaveBeenCalledWith(filesNav)
  })

  it('picks a file row, drawn with the file icon', () => {
    const { onPick } = renderMenu({ items: [fileRow] })
    const row = screen.getByRole('option', { name: /MentionMenu\.tsx/ })
    const icon = row.querySelector('img')!
    expect(icon.getAttribute('src')).toBe(fileIconUrl(FILE_PATH))
    fireEvent.click(row)
    expect(onPick).toHaveBeenCalledWith(fileRow)
  })

  it('draws a folder row with the folder icon, and it picks directly', () => {
    const { onPick } = renderMenu({ items: [folderRow] })
    const row = screen.getByRole('option', { name: /composer/ })
    const icon = row.querySelector('img')!
    expect(icon.getAttribute('src')).toBe(folderIconUrl(FOLDER_PATH))
    // Not the file icon, and not a chevron: the folder row is a target, not a
    // list to open.
    expect(icon.getAttribute('src')).not.toBe(fileIconUrl(FOLDER_PATH))
    expect(row.querySelector('svg')).toBeNull()
    fireEvent.click(row)
    expect(onPick).toHaveBeenCalledWith(folderRow)
  })

  it('shows the active row in the footer, with what accepting it does', () => {
    renderMenu({ items: [fileRow, folderRow], activeIndex: 1 })
    const pinned = footer(screen.getByRole('listbox'))
    expect(within(pinned).getByText(FOLDER_PATH)).toBeTruthy()
    expect(pinned.textContent).toBe(`${FOLDER_PATH}Enter to attach`)
  })

  it('names the list and counts what it holds', () => {
    renderMenu()
    const header = screen.getByText('Mentions').closest('div')!
    expect(header.classList.contains('shrink-0')).toBe(true)
    expect(header.textContent).toBe('Mentions4 rows')

    cleanup()
    renderMenu({ items: [fileRow] })
    expect(screen.getByText('1 row')).toBeTruthy()
  })

  it('fills only the active row, with no hover class left to fight it', () => {
    renderMenu({ items: [fileRow, folderRow], activeIndex: 1 })
    const active = screen.getByRole('option', { name: /^MentionMenu\.tsx/ })
    const idle = screen.getByRole('option', { name: /^composer/ })
    expect(active.getAttribute('aria-selected')).toBe('false')
    expect(active.classList.contains('bg-surface-2')).toBe(false)
    expect(active.classList.contains('hover:bg-surface')).toBe(true)
    expect(idle.getAttribute('aria-selected')).toBe('true')
    expect(idle.classList.contains('bg-surface-2')).toBe(true)
    expect(idle.classList.contains('hover:bg-surface')).toBe(false)
    expect(idle.classList.contains('focus-visible:vy-focus-ring')).toBe(true)
  })

  it('pins the footer outside the scrolling list', () => {
    const { listbox } = renderMenu()
    const pinned = footer(listbox)
    expect(pinned.classList.contains('shrink-0')).toBe(true)
    expect(pinned.classList.contains('border-t')).toBe(true)
    expect(listbox.querySelector('.scroll-thin')!.contains(pinned)).toBe(false)
  })

  it('tracks the composer width between its bounds, then stops growing', () => {
    const narrow = renderMenu({ anchorWidth: 320 }).panel as HTMLElement
    expect(narrow.style.width).toBe('320px')

    cleanup()
    const wide = renderMenu({ anchorWidth: 1200 }).panel as HTMLElement
    expect(wide.style.width).toBe('420px')

    cleanup()
    const tiny = renderMenu({ anchorWidth: 120 }).panel as HTMLElement
    expect(tiny.style.width).toBe('260px')
  })

  it('tells loading, error and no-match apart at a glance', () => {
    const loading = renderMenu({ items: [], view: 'files', loading: true }).listbox
    expect(loading.getAttribute('data-mention-state')).toBe('loading')
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(within(loading).getByRole('status').textContent).toBe('Loading…')
    expect(within(loading).queryByRole('alert')).toBeNull()

    cleanup()
    const failed = renderMenu({
      items: [],
      view: 'files',
      error: 'Workspace is not open'
    }).listbox
    expect(failed.getAttribute('data-mention-state')).toBe('error')
    expect(within(failed).getByRole('alert').textContent).toBe('Workspace is not open')
    expect(within(failed).queryByRole('status')).toBeNull()
    expect(within(failed).queryByText('No files match')).toBeNull()
    expect(footer(failed).textContent).toBe('Nothing to select')

    cleanup()
    const empty = renderMenu({ items: [], view: 'files' }).listbox
    expect(empty.getAttribute('data-mention-state')).toBe('empty')
    expect(empty.getAttribute('aria-busy')).toBeNull()
    expect(within(empty).getByText('No files match')).toBeTruthy()
    expect(within(empty).queryByRole('alert')).toBeNull()
    expect(footer(empty).textContent).toBe('Nothing to select')
  })

  it('marks a busy refresh over existing rows without emptying the list', () => {
    const { listbox } = renderMenu({ loading: true })
    expect(listbox.getAttribute('data-mention-state')).toBe('results')
    expect(within(listbox).getAllByRole('option')).toHaveLength(4)
    expect(within(listbox).queryByRole('status')).toBeNull()
  })
})
