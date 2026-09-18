import { useCallback, useEffect, useState } from 'react'
import type { AgentProfile, AgentProfileCreateRequest, AgentProfileUpdateRequest } from '@shared/ipc'

/**
 * Agent-profile roster state: initial load + live push subscription.
 * The roster is small, so every subscriber replaces its whole list on change.
 */
export function useAgentProfiles(): {
  profiles: AgentProfile[]
  ready: boolean
  error: string | null
  createProfile: (request: AgentProfileCreateRequest) => Promise<AgentProfile | null>
  updateProfile: (request: AgentProfileUpdateRequest) => Promise<AgentProfile | null>
  deleteProfile: (id: string) => Promise<boolean>
  refresh: () => void
} {
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.vyotiq?.agentProfilesList?.().then((res) => {
      if (cancelled) return
      if (res?.ok) setProfiles(res.data)
      else if (res && !res.ok) setError(res.error)
      setReady(true)
    })
    const unsub = window.vyotiq?.onAgentProfilesChanged?.((event) => {
      setProfiles(event.profiles)
      setReady(true)
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const createProfile = useCallback(
    async (request: AgentProfileCreateRequest): Promise<AgentProfile | null> => {
      const res = await window.vyotiq?.agentProfilesCreate?.(request)
      if (res?.ok) {
        // The push channel also refreshes; apply immediately for snappy UI.
        setProfiles((prev) => [...prev.filter((p) => p.id !== res.data.id), res.data])
        return res.data
      }
      if (res && !res.ok) setError(res.error)
      return null
    },
    []
  )

  const updateProfile = useCallback(
    async (request: AgentProfileUpdateRequest): Promise<AgentProfile | null> => {
      const res = await window.vyotiq?.agentProfilesUpdate?.(request)
      if (res?.ok) {
        setProfiles((prev) => prev.map((p) => (p.id === res.data.id ? res.data : p)))
        return res.data
      }
      if (res && !res.ok) setError(res.error)
      return null
    },
    []
  )

  const deleteProfile = useCallback(async (id: string): Promise<boolean> => {
    const res = await window.vyotiq?.agentProfilesDelete?.({ id })
    if (res?.ok) {
      setProfiles((prev) => prev.filter((p) => p.id !== id))
      return true
    }
    if (res && !res.ok) setError(res.error)
    return false
  }, [])

  const refresh = useCallback(() => {
    void window.vyotiq?.agentProfilesList?.().then((res) => {
      if (res?.ok) setProfiles(res.data)
    })
  }, [])

  return { profiles, ready, error, createProfile, updateProfile, deleteProfile, refresh }
}
