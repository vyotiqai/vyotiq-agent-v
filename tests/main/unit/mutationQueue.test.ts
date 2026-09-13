import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  withExclusiveWorkspaceMutation,
  withWorkspaceMutation
} from '@main/workspace/mutationQueue'

function workspace(suffix: string): string {
  return join(tmpdir(), `vyotiq-mutation-queue-${suffix}-${Date.now()}-${Math.random()}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('mutationQueue', () => {
  it('lets disjoint paths overlap', async () => {
    const ws = workspace('disjoint')
    let concurrent = 0
    let maxConcurrent = 0
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let startedA!: () => void
    let startedB!: () => void
    const startedAP = new Promise<void>((resolve) => {
      startedA = resolve
    })
    const startedBP = new Promise<void>((resolve) => {
      startedB = resolve
    })

    const a = withWorkspaceMutation(ws, 'a.ts', async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      startedA()
      await gateA
      concurrent -= 1
    })
    const b = withWorkspaceMutation(ws, 'b.ts', async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      startedB()
      await gateB
      concurrent -= 1
    })

    await Promise.all([startedAP, startedBP])
    expect(maxConcurrent).toBe(2)
    releaseA()
    releaseB()
    await Promise.all([a, b])
  })

  it('serializes mutations on the same path', async () => {
    const ws = workspace('same')
    const order: string[] = []
    let releaseFirst!: () => void
    const gateFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let startedFirst!: () => void
    const startedFirstP = new Promise<void>((resolve) => {
      startedFirst = resolve
    })

    const first = withWorkspaceMutation(ws, 'src/a.ts', async () => {
      order.push('first-start')
      startedFirst()
      await gateFirst
      order.push('first-end')
    })
    const second = withWorkspaceMutation(ws, 'src/a.ts', async () => {
      order.push('second')
    })

    await startedFirstP
    await delay(20)
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('exclusive tree op waits for in-flight path chains and blocks new ones', async () => {
    const ws = workspace('exclusive')
    const order: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let startedA!: () => void
    const startedAP = new Promise<void>((resolve) => {
      startedA = resolve
    })
    let releaseEx!: () => void
    const gateEx = new Promise<void>((resolve) => {
      releaseEx = resolve
    })
    let startedEx!: () => void
    const startedExP = new Promise<void>((resolve) => {
      startedEx = resolve
    })
    let startedB!: () => void
    const startedBP = new Promise<void>((resolve) => {
      startedB = resolve
    })

    const a = withWorkspaceMutation(ws, 'a.ts', async () => {
      order.push('a-start')
      startedA()
      await gateA
      order.push('a-end')
    })
    await startedAP

    const exclusive = withExclusiveWorkspaceMutation(ws, async () => {
      order.push('ex-start')
      startedEx()
      await gateEx
      order.push('ex-end')
    })
    const b = withWorkspaceMutation(ws, 'b.ts', async () => {
      order.push('b-start')
      startedB()
    })

    await delay(20)
    expect(order).toEqual(['a-start'])

    releaseA()
    await startedExP
    await delay(20)
    expect(order).toEqual(['a-start', 'a-end', 'ex-start'])

    releaseEx()
    await startedBP
    await Promise.all([a, exclusive, b])
    expect(order).toEqual(['a-start', 'a-end', 'ex-start', 'ex-end', 'b-start'])
  })
})
