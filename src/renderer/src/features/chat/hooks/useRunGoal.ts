import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, RunGoal, RunLoop } from '@shared/ipc'
import { pushToast } from '@renderer/lib/ui'

const POLL_MS = 2000
const LIVE_POLL_MS = 500

function parseGoal(content: string | null | undefined): RunGoal | null {
  if (!content?.trim()) return null
  try {
    const raw = JSON.parse(content) as Partial<RunGoal>
    if (typeof raw.objective !== 'string' || !raw.objective.trim()) return null
    if (raw.status !== 'active' && raw.status !== 'paused' && raw.status !== 'complete') return null
    if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return null
    return {
      objective: raw.objective,
      status: raw.status,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(typeof raw.continueCount === 'number' ? { continueCount: raw.continueCount } : {})
    }
  } catch {
    return null
  }
}

function parseLoop(content: string | null | undefined): RunLoop | null {
  if (!content?.trim()) return null
  try {
    const raw = JSON.parse(content) as Partial<RunLoop>
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) return null
    if (typeof raw.intervalMs !== 'number') return null
    if (raw.status !== 'armed' && raw.status !== 'stopped') return null
    if (typeof raw.nextAt !== 'string') return null
    return {
      prompt: raw.prompt,
      intervalMs: raw.intervalMs,
      status: raw.status,
      nextAt: raw.nextAt,
      ...(typeof raw.lastTickAt === 'string' ? { lastTickAt: raw.lastTickAt } : {})
    }
  } catch {
    return null
  }
}

/**
 * Structural equality for polled goal/loop payloads. The 500 ms live poll
 * re-parses identical JSON into fresh objects; without this guard every poll
 * re-rendered the whole chat subtree for no data change.
 */
function sameGoal(a: RunGoal | null, b: RunGoal | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.objective === b.objective &&
    a.status === b.status &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.continueCount === b.continueCount
  )
}

function sameLoop(a: RunLoop | null, b: RunLoop | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.prompt === b.prompt &&
    a.intervalMs === b.intervalMs &&
    a.status === b.status &&
    a.nextAt === b.nextAt &&
    a.lastTickAt === b.lastTickAt
  )
}

export function useRunGoal(opts: {
  workspacePath: string | null
  runId: string | null
  running?: boolean
  active?: boolean
}): {
  goal: RunGoal | null
  loop: RunLoop | null
  pause: () => Promise<boolean>
  resume: () => Promise<boolean>
  complete: () => Promise<boolean>
  stopLoop: () => Promise<boolean>
} {
  const { workspacePath, runId, running = false, active = true } = opts
  const [goal, setGoal] = useState<RunGoal | null>(null)
  const [loop, setLoop] = useState<RunLoop | null>(null)
  const loadSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!workspacePath || !runId || !window.vyotiq?.readRunArtifact) {
      if (seq !== loadSeqRef.current) return
      setGoal(null)
      setLoop(null)
      return
    }
    const [goalRes, loopRes] = await Promise.all([
      window.vyotiq.readRunArtifact({ workspacePath, runId, name: 'goal.json' }),
      window.vyotiq.readRunArtifact({ workspacePath, runId, name: 'loop.json' })
    ])
    if (seq !== loadSeqRef.current) return
    const nextGoal = goalRes.ok ? parseGoal(goalRes.data.content) : null
    const nextLoop = loopRes.ok ? parseLoop(loopRes.data.content) : null
    setGoal((prev) => (sameGoal(prev, nextGoal) ? prev : nextGoal))
    setLoop((prev) => (sameLoop(prev, nextLoop) ? prev : nextLoop))
  }, [workspacePath, runId])

  useEffect(() => {
    void load()
  }, [load])

  const hasVisibleGoal = Boolean(goal && goal.status !== 'complete')
  const hasArmedLoop = loop?.status === 'armed'
  useEffect(() => {
    // Same L-12 gate as useRunTodos: a mounted pane must not keep polling
    // artifacts on an idle run forever. State arrives via `goal_update` /
    // `loop_update` push events while the run is live.
    if (!active || !running || !workspacePath || !runId) return
    const ms = hasVisibleGoal || hasArmedLoop ? LIVE_POLL_MS : POLL_MS
    const id = window.setInterval(() => {
      void load()
    }, ms)
    return () => window.clearInterval(id)
  }, [active, workspacePath, runId, running, hasVisibleGoal, hasArmedLoop, load])

  useEffect(() => {
    if (!runId || !window.vyotiq?.onChatEvent) return
    return window.vyotiq.onChatEvent((event: AgentEvent) => {
      if (event.runId !== runId) return
      if (event.type === 'goal_update') {
        setGoal((prev) => (sameGoal(prev, event.goal) ? prev : event.goal))
      }
      if (event.type === 'loop_update') {
        setLoop((prev) => (sameLoop(prev, event.loop) ? prev : event.loop))
      }
    })
  }, [runId])

  const pause = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !runId || !window.vyotiq?.setGoalStatus) return false
    const res = await window.vyotiq.setGoalStatus({
      workspacePath,
      runId,
      action: 'pause'
    })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    setGoal((prev) => (sameGoal(prev, res.data.goal) ? prev : res.data.goal))
    return true
  }, [workspacePath, runId])

  const resume = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !runId || !window.vyotiq?.setGoalStatus) return false
    const res = await window.vyotiq.setGoalStatus({
      workspacePath,
      runId,
      action: 'resume'
    })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    setGoal((prev) => (sameGoal(prev, res.data.goal) ? prev : res.data.goal))
    return true
  }, [workspacePath, runId])

  const complete = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !runId || !window.vyotiq?.setGoalStatus) return false
    const res = await window.vyotiq.setGoalStatus({
      workspacePath,
      runId,
      action: 'complete'
    })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    setGoal((prev) => (sameGoal(prev, res.data.goal) ? prev : res.data.goal))
    return true
  }, [workspacePath, runId])

  const stopLoop = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !runId || !window.vyotiq?.setLoop) return false
    const res = await window.vyotiq.setLoop({
      workspacePath,
      runId,
      action: 'stop'
    })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    setLoop((prev) => (sameLoop(prev, res.data.loop) ? prev : res.data.loop))
    return true
  }, [workspacePath, runId])

  return { goal, loop, pause, resume, complete, stopLoop }
}
