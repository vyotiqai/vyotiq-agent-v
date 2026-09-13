import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  emptySecretStatus,
  type Settings,
  type SecretProvider,
  type IpcResult
} from '@shared/ipc'
import { logger } from '@shared/logger'
import { initRendererSentry } from '../../logging/sentry'

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [secrets, setSecrets] = useState<Record<SecretProvider, boolean>>(emptySecretStatus)
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [secretsLoadError, setSecretsLoadError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Monotonic generation so out-of-order IPC replies cannot revert newer state. */
  const generationRef = useRef(0)

  const refresh = useCallback(async () => {
    const gen = ++generationRef.current
    const [s, k] = await Promise.all([window.vyotiq.getSettings(), window.vyotiq.secretStatus()])
    if (gen !== generationRef.current) return
    if (s.ok) setSettings(s.data)
    else {
      logger.warn('getSettings failed', { scope: 'settings', err: s.error })
      setError(s.error)
    }
    if (k.ok) {
      setSecrets(k.data.keys)
      setEncryptionAvailable(k.data.encryptionAvailable)
      setSecretsLoadError(Boolean(k.data.loadError))
    } else {
      logger.warn('secretStatus failed', { scope: 'settings', err: k.error })
      setError((prev) => prev ?? k.error)
      // Clear stale banner — loadError only comes from a successful response.
      setSecretsLoadError(false)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const update = useCallback(async (partial: Partial<Settings>): Promise<IpcResult<Settings>> => {
    const gen = ++generationRef.current
    const res = await window.vyotiq.setSettings(partial)
    if (gen !== generationRef.current) {
      return res
    }
    if (res.ok) {
      setSettings(res.data)
      setError(null)
      if (partial.telemetryEnabled !== undefined) {
        initRendererSentry(res.data.telemetryEnabled)
      }
    } else {
      logger.error('setSettings failed', { scope: 'settings', err: res.error })
      setError(res.error)
    }
    return res
  }, [])

  const saveSecret = useCallback(
    async (provider: SecretProvider, key: string): Promise<IpcResult<true>> => {
      const res = await window.vyotiq.setSecret(provider, key)
      if (res.ok) {
        setError(null)
        setSecrets((prev) => ({ ...prev, [provider]: true }))
        await refresh()
      } else {
        logger.error('setSecret failed', { scope: 'settings', provider, err: res.error })
        setError(res.error)
      }
      return res
    },
    [refresh]
  )

  const removeSecret = useCallback(
    async (provider: SecretProvider): Promise<IpcResult<true>> => {
      const res = await window.vyotiq.clearSecret(provider)
      if (res.ok) {
        setError(null)
        setSecrets((prev) => ({ ...prev, [provider]: false }))
        await refresh()
      } else {
        logger.error('clearSecret failed', { scope: 'settings', provider, err: res.error })
        setError(res.error)
      }
      return res
    },
    [refresh]
  )

  const pickWorkspace = useCallback(async (): Promise<IpcResult<string | null>> => {
    const res = await window.vyotiq.pickWorkspace()
    if (res.ok && res.data) {
      setError(null)
    } else if (!res.ok) {
      logger.error('pickWorkspace failed', { scope: 'settings', err: res.error })
      setError(res.error)
    }
    return res
  }, [])

  return {
    settings,
    secrets,
    encryptionAvailable,
    secretsLoadError,
    loading,
    error,
    setError,
    refresh,
    update,
    saveSecret,
    removeSecret,
    pickWorkspace
  }
}
