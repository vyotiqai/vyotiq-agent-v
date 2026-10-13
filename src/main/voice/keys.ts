import { getSecret, getVoiceKey } from '../settings/secrets'
import {
  VOICE_KEY_VENDORS,
  type VoiceKeyAvailability,
  type VoiceKeySource,
  type VoiceKeyVendor
} from '../../shared/voice'
import type { VoiceKeyState, VoiceKeyStatus } from '../../shared/ipc/schemas/voice'
import { VoiceError } from './errors'

/** The key for a provider, or null. `none` sources (local) have no key. */
export function readVoiceSourceKey(source: VoiceKeySource): string | null {
  switch (source.kind) {
    case 'none':
      return null
    case 'voice':
      return getVoiceKey(source.vendor)
    case 'chat':
      return getSecret(source.provider)
  }
}

/** Like `readVoiceSourceKey`, but a missing key is a typed `no_key` failure. */
export function requireVoiceSourceKey(source: VoiceKeySource): string {
  if (source.kind === 'none') return ''
  const key = readVoiceSourceKey(source)
  if (!key) {
    const who = source.kind === 'voice' ? source.vendor : source.provider
    throw new VoiceError('no_key', `No API key for ${who}`)
  }
  return key
}

function safeRead(read: () => string | null): string | null {
  try {
    return read()
  } catch {
    // An unreadable store (keychain locked, insecure backend) reads as "not set".
    return null
  }
}

function keyState(key: string | null): VoiceKeyState {
  return key ? { set: true, last4: key.slice(-4) } : { set: false }
}

/** What the renderer may see: set or not, and the last four characters. */
export function voiceKeyStatus(): VoiceKeyStatus {
  const voice: Partial<Record<VoiceKeyVendor, VoiceKeyState>> = {}
  for (const vendor of VOICE_KEY_VENDORS) voice[vendor] = keyState(safeRead(() => getVoiceKey(vendor)))
  return {
    voice,
    chat: {
      openai: safeRead(() => getSecret('openai')) !== null,
      openrouter: safeRead(() => getSecret('openrouter')) !== null
    }
  }
}

export function voiceKeyAvailability(status: VoiceKeyStatus = voiceKeyStatus()): VoiceKeyAvailability {
  const voice: Partial<Record<VoiceKeyVendor, boolean>> = {}
  for (const vendor of VOICE_KEY_VENDORS) voice[vendor] = status.voice[vendor]?.set === true
  return { voice, chat: { ...status.chat } }
}
