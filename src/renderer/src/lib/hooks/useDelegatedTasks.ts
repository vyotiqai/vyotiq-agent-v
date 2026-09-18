import { useCallback, useEffect, useState } from 'react'
import type { DelegatedTask, TaskEnqueueRequest } from '@shared/ipc'

/** Delegated-task list state: initial load + live push subscription. */
export function useDelegatedTasks(): {
  tasks: DelegatedTask[]
  ready: boolean
  enqueueTask: (request: TaskEnqueueRequest) => Promise<DelegatedTask | null>
  cancelTask: (id: string) => Promise<boolean>
} {
  const [tasks, setTasks] = useState<DelegatedTask[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.vyotiq?.tasksList?.().then((res) => {
      if (cancelled) return
      if (res?.ok) setTasks(res.data)
      setReady(true)
    })
    const unsub = window.vyotiq?.onTasksChanged?.((event) => {
      setTasks(event.tasks)
      setReady(true)
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const enqueueTask = useCallback(
    async (request: TaskEnqueueRequest): Promise<DelegatedTask | null> => {
      const res = await window.vyotiq?.tasksEnqueue?.(request)
      if (res?.ok) {
        setTasks((prev) => [res.data, ...prev.filter((t) => t.id !== res.data.id)])
        return res.data
      }
      return null
    },
    []
  )

  const cancelTask = useCallback(async (id: string): Promise<boolean> => {
    const res = await window.vyotiq?.tasksCancel?.({ id })
    return res?.ok === true
  }, [])

  return { tasks, ready, enqueueTask, cancelTask }
}
