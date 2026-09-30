/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useRecordScroll } from '@renderer/features/task/useRecordScroll'

/** A scroll box jsdom can reason about: fixed viewport, growable content. */
type Box = { el: HTMLDivElement; grow: (px: number) => void; scrollTo: ReturnType<typeof vi.fn> }

let observers: Array<() => void> = []

beforeEach(() => {
  observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly cb: () => void
      constructor(cb: () => void) {
        this.cb = cb
        observers.push(() => this.cb())
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function makeBox(el: HTMLDivElement, initialHeight: number): Box {
  let height = initialHeight
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, height - 400))
    }
  })
  const scrollTo = vi.fn((opts: { top: number }) => {
    el.scrollTop = opts.top
  })
  el.scrollTo = scrollTo as unknown as typeof el.scrollTo
  return { el, grow: (px) => (height += px), scrollTo }
}

function Harness(props: { live: boolean; onReady: (api: ReturnType<typeof useRecordScroll>) => void }) {
  const api = useRecordScroll({ ready: true, live: props.live })
  props.onReady(api)
  return (
    <div ref={api.scrollRef} onScroll={api.onScroll} data-testid="scroll">
      <div ref={api.contentRef} />
    </div>
  )
}

function mount(live: boolean) {
  let api!: ReturnType<typeof useRecordScroll>
  const view = render(<Harness live={live} onReady={(a) => (api = a)} />)
  const box = makeBox(view.getByTestId('scroll') as HTMLDivElement, 2000)
  const rerender = (nextLive: boolean) => view.rerender(<Harness live={nextLive} onReady={(a) => (api = a)} />)
  return { box, rerender, api: () => api }
}

/** Follow the bottom as a reader who pressed End would. */
function follow(box: Box, api: ReturnType<typeof useRecordScroll>): void {
  act(() => api.jumpBottom())
  box.el.dispatchEvent(new Event('scroll'))
}

describe('useRecordScroll', () => {
  it('follows a live run you are at the end of as it grows', () => {
    const { box, api } = mount(true)
    follow(box, api())
    box.grow(300)
    act(() => observers.forEach((fire) => fire()))
    expect(box.el.scrollTop).toBe(box.el.scrollHeight - 400)
  })

  it('lets go at the first wheel turn up, before the view has moved far', () => {
    const { box, api } = mount(true)
    follow(box, api())
    box.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }))
    // A smooth scroll's first event still reads near the bottom…
    box.el.scrollTop = box.el.scrollHeight - 400 - 30
    box.el.dispatchEvent(new Event('scroll'))
    const before = box.el.scrollTop
    box.grow(300)
    act(() => observers.forEach((fire) => fire()))
    // …and growth no longer pulls the reader back down.
    expect(box.el.scrollTop).toBe(before)
    expect(api().isFollowing()).toBe(false)
  })

  it('keeps following through End’s glide while the record grows', () => {
    const { box, api } = mount(true)
    box.el.scrollTop = 0
    act(() => api().jumpBottom())
    // Scroll events of the glide itself, far from the bottom, are not the reader's.
    box.el.scrollTop = 500
    box.el.dispatchEvent(new Event('scroll'))
    expect(api().isFollowing()).toBe(true)
    box.grow(500)
    act(() => observers.forEach((fire) => fire()))
    expect(box.el.scrollTop).toBe(box.el.scrollHeight - 400)
  })

  it('stays at the end, on the answer, when the run you followed ends', () => {
    const { box, api, rerender } = mount(true)
    follow(box, api())
    box.scrollTo.mockClear()
    rerender(false)
    expect(box.scrollTo).not.toHaveBeenCalled()
    expect(box.el.scrollTop).toBe(box.el.scrollHeight - 400)
  })

  it('leaves a reader who scrolled up where they are when the run ends', () => {
    const { box, api, rerender } = mount(true)
    follow(box, api())
    box.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }))
    box.el.scrollTop = 200
    box.el.dispatchEvent(new Event('scroll'))
    box.scrollTo.mockClear()
    rerender(false)
    expect(box.scrollTo).not.toHaveBeenCalled()
    expect(box.el.scrollTop).toBe(200)
  })

  it('brings a card deep in the record to the top of the view, and stops following there', () => {
    const { box, api } = mount(true)
    follow(box, api())
    // A card 300px above the view's top edge, which sits at the end of 2000px.
    const card = document.createElement('div')
    card.getBoundingClientRect = () => ({ top: -300 }) as DOMRect
    box.el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    act(() => api().jumpTo(card))
    expect(box.scrollTo).toHaveBeenLastCalledWith({ top: 1600 - 300 - 16, behavior: 'smooth' })
    // The glide's own scroll events are not the reader's; growth leaves it on the card.
    box.el.dispatchEvent(new Event('scroll'))
    box.grow(500)
    act(() => observers.forEach((fire) => fire()))
    expect(box.el.scrollTop).toBe(1600 - 300 - 16)
    expect(api().isFollowing()).toBe(false)
  })

  it('ends a glide whose target the record shrank below, so the reader’s own scrolling counts again', () => {
    const { box, api } = mount(false)
    box.el.scrollTop = 0
    const card = document.createElement('div')
    card.getBoundingClientRect = () => ({ top: 1500 }) as DOMRect
    box.el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    // A smooth glide still under way…
    box.scrollTo.mockImplementation(() => {})
    act(() => api().jumpTo(card))
    // …when a step folds: the record is 1200px now, its end at 800.
    box.grow(-800)
    box.el.scrollTop = 800
    box.el.dispatchEvent(new Event('scroll'))
    // The reader scrolls up and back to the end: theirs, so it follows again.
    box.el.scrollTop = 500
    box.el.dispatchEvent(new Event('scroll'))
    box.el.scrollTop = 800
    box.el.dispatchEvent(new Event('scroll'))
    expect(api().isFollowing()).toBe(true)
  })
})
