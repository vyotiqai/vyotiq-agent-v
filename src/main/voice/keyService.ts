/**
 * Saving and checking voice vendor keys (docs/voice-mode.md §12). A key is
 * checked with a cheap authenticated call before it is saved: a key the
 * vendor rejects is refused; one we couldn't check (offline, vendor down) is
 * saved and checked again on first use.
 */
import { clearVoiceKey, enqueueSecretsMutation, setVoiceKey } from '../settings/secrets'
import { voiceErrorFromStatus, type VoiceKeyVendor } from '../../shared/voice'
import { VoiceError } from './errors'
import { voiceKeyStatus } from './keys'
import type { VoiceKeyStatus } from '../../shared/ipc/schemas/voice'

const VERIFY_TIMEOUT_MS = 8000

type VerifyRequest = { url: string; headers: (key: string) => Record<string, string> }

/**
 * One read-only endpoint per vendor that needs nothing but a valid key.
 * Endpoints and headers are rechecked against vendor docs in the Phase 1
 * spike; only a 401/403 counts as "rejected", so a moved endpoint can never
 * make a good key unusable.
 */
const VERIFY: Readonly<Record<VoiceKeyVendor, VerifyRequest>> = {
  deepgram: {
    url: 'https://api.deepgram.com/v1/projects',
    headers: (key) => ({ Authorization: `Token ${key}` })
  },
  assemblyai: {
    url: 'https://api.assemblyai.com/v2/transcript?limit=1',
    headers: (key) => ({ Authorization: key })
  },
  elevenlabs: {
    url: 'https://api.elevenlabs.io/v1/voices',
    headers: (key) => ({ 'xi-api-key': key })
  },
  cartesia: {
    url: 'https://api.cartesia.ai/voices?limit=1',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-08-14' })
  }
}

export type VoiceKeyCheck =
  /** The vendor accepted the key. */
  | 'verified'
  /** Couldn't reach the vendor, or it answered oddly; saved, checked on first use. */
  | 'unchecked'

type Fetch = typeof fetch

/** Throws `rejected_key` / `out_of_credit` for a key the vendor refuses. */
export async function checkVoiceKey(
  vendor: VoiceKeyVendor,
  key: string,
  fetchImpl: Fetch = fetch
): Promise<VoiceKeyCheck> {
  const req = VERIFY[vendor]
  let res: Response
  try {
    res = await fetchImpl(req.url, {
      method: 'GET',
      headers: req.headers(key),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    })
  } catch {
    return 'unchecked'
  }
  if (res.ok) return 'verified'
  const code = voiceErrorFromStatus(res.status)
  if (code === 'rejected_key' || code === 'out_of_credit') {
    throw new VoiceError(code, `${vendor} refused the key (HTTP ${res.status})`)
  }
  return 'unchecked'
}

export type SaveVoiceKeyResult = { check: VoiceKeyCheck; status: VoiceKeyStatus }

export async function saveVoiceKey(
  vendor: VoiceKeyVendor,
  key: string,
  fetchImpl: Fetch = fetch
): Promise<SaveVoiceKeyResult> {
  const trimmed = key.trim()
  const check = await checkVoiceKey(vendor, trimmed, fetchImpl)
  await enqueueSecretsMutation(() => setVoiceKey(vendor, trimmed))
  return { check, status: voiceKeyStatus() }
}

export async function removeVoiceKey(vendor: VoiceKeyVendor): Promise<VoiceKeyStatus> {
  await enqueueSecretsMutation(() => clearVoiceKey(vendor))
  return voiceKeyStatus()
}
