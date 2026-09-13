/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import {
  isElementVisibleInRoot,
  measureTasksAnchorVisible,
  resolveTasksAnchorRowIndex
} from '@renderer/features/chat/hooks/useTasksAnchorVisible'
import type { TranscriptRow } from '@renderer/features/chat/utils/transcriptRows'

function userRow(id: string): TranscriptRow {
  return {
    kind: 'user',
    id: `row-${id}`,
    turnIndex: 0,
    item: {
      kind: 'message',
      id,
      role: 'user',
      content: 'hello',
      images: []
    }
  }
}

function box(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 300,
    width: 300,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

describe('resolveTasksAnchorRowIndex', () => {
  it('returns the user row index for the anchor id', () => {
    const rows = [userRow('user-0'), userRow('user-1')]
    expect(resolveTasksAnchorRowIndex(rows, 'user-1')).toBe(1)
  })

  it('returns null when the anchor id is missing', () => {
    const rows = [userRow('user-0')]
    expect(resolveTasksAnchorRowIndex(rows, 'user-9')).toBeNull()
    expect(resolveTasksAnchorRowIndex(rows, null)).toBeNull()
  })
})

describe('isElementVisibleInRoot', () => {
  it('detects overlap between element and scroll root', () => {
    const root = document.createElement('div')
    const child = document.createElement('div')
    root.appendChild(child)
    document.body.appendChild(root)

    root.getBoundingClientRect = () => box(0, 400)
    child.getBoundingClientRect = () => box(50, 100)
    expect(isElementVisibleInRoot(child, root)).toBe(true)

    child.getBoundingClientRect = () => box(500, 550)
    expect(isElementVisibleInRoot(child, root)).toBe(false)

    document.body.removeChild(root)
  })

  it('treats a thin sliver at the viewport edge as hidden', () => {
    const root = document.createElement('div')
    const child = document.createElement('div')
    root.appendChild(child)
    document.body.appendChild(root)

    root.getBoundingClientRect = () => box(0, 400)
    child.getBoundingClientRect = () => box(-70, 8)
    expect(isElementVisibleInRoot(child, root)).toBe(false)

    child.getBoundingClientRect = () => box(-20, 40)
    expect(isElementVisibleInRoot(child, root)).toBe(true)

    document.body.removeChild(root)
  })
})

describe('measureTasksAnchorVisible', () => {
  it('uses band geometry when the ceiling band is mounted', () => {
    const root = document.createElement('div')
    const band = document.createElement('div')
    band.setAttribute('data-tasks-ceiling', '')
    root.appendChild(band)
    document.body.appendChild(root)

    root.getBoundingClientRect = () => box(0, 400)
    band.getBoundingClientRect = () => box(50, 100)
    expect(measureTasksAnchorVisible(root)).toBe(true)

    band.getBoundingClientRect = () => box(-80, -20)
    expect(measureTasksAnchorVisible(root)).toBe(false)

    document.body.removeChild(root)
  })

  it('returns false when the band is not in the DOM', () => {
    const root = document.createElement('div')
    expect(measureTasksAnchorVisible(root)).toBe(false)
    expect(measureTasksAnchorVisible(null)).toBe(true)
  })
})
