import { useEffect, useRef, useState } from 'react'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SecretProvider } from '@shared/ipc'
import {
  DEFAULT_VOICE_SETTINGS,
  type VoiceEndOfTurnPatience,
  type VoiceInterruptMode,
  type VoiceKeyStatus,
  type VoiceSettings
} from '@shared/ipc/schemas/voice'
import {
  STT_CATALOG,
  TTS_CATALOG,
  VOICE_KEY_VENDORS,
  VOICE_KEY_VENDOR_LABEL,
  clampSpeed,
  keySourceReady,
  parseVoiceIpcCode,
  resolveModel,
  resolveSttProvider,
  resolveTtsProvider,
  sttEntry,
  ttsEntry,
  type SttProviderId,
  type TtsProviderId,
  type VoiceErrorCode,
  type VoiceKeyAvailability,
  type VoiceKeySource,
  type VoiceKeyVendor
} from '@shared/voice'
import { Icon } from '@renderer/lib/icons'
import { Button, Input, Menu, cn, selectTriggerClass } from '@renderer/lib/ui'
import { speakText, stopSpeech, useSpeech } from '@renderer/features/voice/speechPlayback'
import type { VoiceOptionInfo } from '@shared/ipc/schemas/voice'
import { SegmentedField } from '../components/SegmentedField'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'
import type { SettingsOption } from '../types'

/*
  Settings → Voice → Voice mode (docs/voice-mode.md §13.7). Who listens and
  who speaks, each from the provider catalog with your own key; the keys for
  every voice vendor in one place; and how the voice agent behaves. Rows at
  their default stay muted, so what you changed stands out.
*/

const SPEED_OPTIONS: readonly SettingsOption<string>[] = [
  { value: '0.85', label: 'Slower' },
  { value: '1', label: 'Normal' },
  { value: '1.15', label: 'Faster' },
  { value: '1.3', label: 'Fastest' }
]

const INTERRUPT_OPTIONS: readonly SettingsOption<VoiceInterruptMode>[] = [
  { value: 'steer', label: 'Redirect the agent' },
  { value: 'cancel', label: 'Stop the agent' },
  { value: 'off', label: 'Just stop talking' }
]

const PATIENCE_OPTIONS: readonly SettingsOption<VoiceEndOfTurnPatience>[] = [
  { value: 'quick', label: 'Quick' },
  { value: 'normal', label: 'Normal' },
  { value: 'patient', label: 'Patient' }
]

const LANGUAGE_OPTIONS: readonly SettingsOption<string>[] = [
  { value: '', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'hi', label: 'Hindi' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'nl', label: 'Dutch' }
]

/** What Preview says: short, and in the voice of a finished task. */
export const PREVIEW_LINE = 'Done. I fixed the failing test, and the diff is on screen.'

/** The voice picker for the current speaking provider, with a Preview. */
function VoicePicker({
  provider,
  providerLabel,
  value,
  fallback,
  speed,
  keyReady,
  keysVersion,
  locked,
  changed,
  onChange
}: {
  provider: TtsProviderId
  providerLabel: string
  value: string
  fallback: { id: string; label: string }
  speed: number
  keyReady: boolean
  /** Bumps when keys change, so the list is fetched again with the new key. */
  keysVersion: string
  locked: boolean
  changed: boolean
  onChange: (voiceId: string) => void
}) {
  const [voices, setVoices] = useState<VoiceOptionInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const preview = useSpeech('preview')

  useEffect(() => {
    let live = true
    setVoices(null)
    setLoadError(null)
    void window.vyotiq.voiceListVoices?.({ provider })?.then((res) => {
      if (!live) return
      if (res.ok) setVoices(res.data)
      else setLoadError(`Couldn’t load ${providerLabel} voices.`)
    })
    return () => {
      live = false
    }
  }, [provider, providerLabel, keysVersion])

  const list = voices ?? []
  const current = value || fallback.id || list[0]?.id || ''
  const options = list.map((v) => ({
    value: v.id,
    label: v.description ? `${v.label} · ${v.description}` : v.label,
    group: v.custom ? 'Your voices' : list.some((x) => x.custom) ? 'Library' : undefined
  }))
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: current === fallback.id ? fallback.label : current, group: undefined })
  }

  const hint = !keyReady
    ? `Add your ${providerLabel} key to hear previews and see all its voices.`
    : loadError ?? (voices === null ? 'Loading voices…' : `${list.length} voices`)

  return (
    <SettingsField
      id="voice-voice"
      title="Voice"
      hint={hint}
      changed={changed}
      below={preview.error ? <p className="m-0 text-xs text-danger" role="alert">{preview.error}</p> : null}
    >
      <div className="flex items-center gap-2">
        <div style={{ minWidth: 260 }}>
          <Menu
            aria-label="Voice"
            value={current}
            options={options}
            searchable={options.length > 12}
            placement="down"
            disabled={locked || options.length === 0}
            triggerClassName={cn(selectTriggerClass({ quiet: !changed, mono: false }), 'w-full')}
            onChange={(next) => {
              if (next !== value) onChange(next)
            }}
          />
        </div>
        <Button
          size="xs"
          variant="secondary"
          icon={preview.active ? 'stop' : 'play'}
          disabled={!keyReady || !current}
          aria-pressed={preview.active}
          data-voice-preview={preview.active ? preview.phase : 'idle'}
          onClick={() =>
            preview.active
              ? stopSpeech()
              : void speakText('preview', { text: PREVIEW_LINE, kind: 'plain', provider, voiceId: current, speed })
          }
        >
          {preview.active ? 'Stop' : 'Preview'}
        </Button>
      </div>
    </SettingsField>
  )
}

/** The words for a key the vendor refused or we couldn't check (§13.7 "States and copy"). */
export function voiceKeyProblem(code: VoiceErrorCode | 'unchecked', vendor: string): string {
  switch (code) {
    case 'rejected_key':
      return `${vendor} rejected this key. Check it in your ${vendor} dashboard.`
    case 'out_of_credit':
      return `${vendor} says this account is out of credit.`
    case 'unchecked':
    case 'offline':
    case 'provider_down':
      return `Couldn’t reach ${vendor}. Saved; it’s checked again on first use.`
    default:
      return `${vendor} couldn’t check this key. Try again.`
  }
}

function sourceName(source: VoiceKeySource): string {
  if (source.kind === 'voice') return VOICE_KEY_VENDOR_LABEL[source.vendor]
  if (source.kind === 'chat') return source.provider === 'openai' ? 'OpenAI' : 'OpenRouter'
  return ''
}

function PrivacyHint({ text, local }: { text: string; local: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon name={local ? 'lock' : 'cloud'} size={13} className="text-tertiary" />
      {text}
    </span>
  )
}

/** One vendor's key: its state, and Add / Replace / Remove with an inline field. */
function VendorKeyRow({
  vendor,
  state,
  inUse,
  locked,
  onChanged
}: {
  vendor: VoiceKeyVendor
  state: VoiceKeyStatus['voice'][VoiceKeyVendor]
  inUse: boolean
  locked: boolean
  onChanged: (status: VoiceKeyStatus) => void
}) {
  const label = VOICE_KEY_VENDOR_LABEL[vendor]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const set = state?.set === true

  // Opening the field moves focus into it, in response to the button press.
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const save = async (): Promise<void> => {
    if (!draft.trim()) return
    setBusy(true)
    setNote(null)
    const res = await window.vyotiq.voiceSetKey({ vendor, key: draft })
    setBusy(false)
    if (res.ok) {
      onChanged(res.data.status)
      setEditing(false)
      setDraft('')
      setNote(
        res.data.check === 'verified'
          ? { tone: 'ok', text: 'Verified' }
          : { tone: 'warn', text: voiceKeyProblem('unchecked', label) }
      )
      return
    }
    const code = parseVoiceIpcCode(res.code)
    setNote({ tone: 'danger', text: code ? voiceKeyProblem(code, label) : (res.error ?? 'That didn’t work') })
  }

  const remove = async (): Promise<void> => {
    if (inUse && !confirmRemove) {
      setConfirmRemove(true)
      return
    }
    setConfirmRemove(false)
    setBusy(true)
    const res = await window.vyotiq.voiceClearKey({ vendor })
    setBusy(false)
    setNote(null)
    if (res.ok) onChanged(res.data)
  }

  const status = set ? (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <Icon name="checkCircle" size={13} />
      Saved <span className="font-mono tnum text-tertiary">{`••••${state?.last4 ?? ''}`}</span>
    </span>
  ) : (
    <span className="text-tertiary">Not set</span>
  )

  return (
    <div className="py-1.5" data-voice-key={vendor}>
      <div className="flex min-h-8 items-center gap-3">
        <span className="w-28 shrink-0 text-sm text-fg">{label}</span>
        <span className="min-w-0 flex-1 text-xs">{status}</span>
        {editing ? null : confirmRemove ? (
          <span className="flex items-center gap-1">
            <span className="text-xs text-muted">Voice mode uses this key. Remove it?</span>
            <Button size="xs" variant="secondary" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Button size="xs" variant="secondary" icon="key" disabled={locked || busy} onClick={() => setEditing(true)}>
              {set ? 'Replace' : 'Add key'}
            </Button>
            {set ? (
              <Button size="xs" variant="ghost" disabled={locked || busy} onClick={() => void remove()}>
                Remove
              </Button>
            ) : null}
          </span>
        )}
      </div>
      {editing ? (
        <form
          className="mt-1.5 flex items-center gap-2 pl-31"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Input
            ref={inputRef}
            size="sm"
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${label} API key`}
            placeholder={`Paste your ${label} API key`}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button size="xs" variant="primary" type="submit" disabled={busy || !draft.trim()}>
            {busy ? 'Checking…' : 'Save'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false)
              setDraft('')
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {note ? (
        <p
          className={cn(
            'm-0 mt-1 flex items-center gap-1.5 pl-31 text-xs',
            note.tone === 'danger' ? 'text-danger' : note.tone === 'warn' ? 'text-warning' : 'text-muted'
          )}
          role={note.tone === 'ok' ? 'status' : 'alert'}
        >
          <Icon name={note.tone === 'ok' ? 'checkCircle' : 'warningCircle'} size={13} />
          {note.text}
        </p>
      ) : null}
    </div>
  )
}

export function VoiceModeSettings({
  form,
  secrets
}: {
  form: SettingsFormState
  secrets: Record<SecretProvider, boolean>
}) {
  const voice: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...form.settings.voice }
  const locked = form.formLocked
  const [keyStatus, setKeyStatus] = useState<VoiceKeyStatus | null>(null)

  useEffect(() => {
    let live = true
    // Optional call: a bridge from an older preload (or a test double) may not have it yet.
    void window.vyotiq.voiceKeyStatus?.().then((res) => {
      if (live && res?.ok) setKeyStatus(res.data)
    })
    return () => {
      live = false
    }
  }, [])

  const keys: VoiceKeyAvailability = {
    voice: Object.fromEntries(VOICE_KEY_VENDORS.map((v) => [v, keyStatus?.voice[v]?.set === true])),
    chat: { openai: secrets.openai === true, openrouter: secrets.openrouter === true }
  }

  const patch = (next: Partial<VoiceSettings>): void => {
    void form.runUpdate({ voice: { ...voice, ...next } })
  }

  const sttResolved = resolveSttProvider(voice.sttProvider, keys)
  const ttsResolved = resolveTtsProvider(voice.ttsProvider, keys)
  const sttShown: SttProviderId = voice.sttProvider !== 'auto' ? voice.sttProvider : sttResolved.ok ? sttResolved.id : 'deepgram'
  const ttsShown: TtsProviderId = voice.ttsProvider !== 'auto' ? voice.ttsProvider : ttsResolved.ok ? ttsResolved.id : 'elevenlabs'
  const stt = sttEntry(sttShown)
  const tts = ttsEntry(ttsShown)

  const keyLabel = (source: VoiceKeySource): string =>
    source.kind === 'none' ? '' : keySourceReady(source, keys) ? '' : ' · needs a key'

  const sttOptions: SettingsOption<string>[] = [
    { value: 'auto', label: sttResolved.ok ? `Automatic · ${sttEntry(sttResolved.id).label}` : 'Automatic' },
    ...STT_CATALOG.map((e) => ({ value: e.id, label: `${e.label}${e.beta ? ' (beta)' : ''}${keyLabel(e.key)}` }))
  ]
  const ttsOptions: SettingsOption<string>[] = [
    { value: 'auto', label: ttsResolved.ok ? `Automatic · ${ttsEntry(ttsResolved.id).label}` : 'Automatic' },
    ...TTS_CATALOG.map((e) => ({ value: e.id, label: `${e.label}${keyLabel(e.key)}` }))
  ]

  const missingKey = (source: VoiceKeySource) =>
    source.kind !== 'none' && !keySourceReady(source, keys) ? (
      <div className="flex items-center gap-2 text-xs text-warning" role="alert">
        <Icon name="warningCircle" size={13} />
        <span className="flex-1">{`No ${sourceName(source)} key yet. Voice mode uses the next provider that has one.`}</span>
        {source.kind === 'chat' ? (
          <Button size="xs" variant="secondary" icon="key" onClick={() => form.navigateSection('providers')}>
            Add in Providers
          </Button>
        ) : (
          <span className="text-tertiary">Add it under Keys below</span>
        )}
      </div>
    ) : null

  const fellBack =
    (sttResolved.ok && sttResolved.fellBackFrom) || (ttsResolved.ok && ttsResolved.fellBackFrom) ? true : false

  const speedValue = SPEED_OPTIONS.some((o) => Number(o.value) === voice.speed) ? String(voice.speed) : '1'
  const sttModel = resolveModel(stt.models, voice.stt[stt.id]?.model)
  const ttsModel = resolveModel(tts.models, voice.tts[tts.id]?.model)
  const inUseVendors = new Set<VoiceKeyVendor>(
    [stt.key, tts.key].flatMap((k) => (k.kind === 'voice' ? [k.vendor] : []))
  )

  return (
    <>
      <SettingsGroup
        title="Voice mode"
        description="Talk with the agent. It answers out loud and puts the details on screen."
      >
        <SelectField
          id="voice-stt"
          title="Listens with"
          hint={<PrivacyHint text={stt.privacy} local={stt.key.kind === 'none'} />}
          value={voice.sttProvider}
          options={sttOptions}
          width={260}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'sttProvider')}
          below={voice.sttProvider === 'auto' ? null : missingKey(stt.key)}
          onChange={(v) => patch({ sttProvider: v as VoiceSettings['sttProvider'] })}
        />
        {stt.models.length > 1 ? (
          <SelectField
            id="voice-stt-model"
            title="Listening model"
            nested
            hint={stt.trait}
            value={sttModel}
            options={stt.models.map((m) => ({ value: m.id, label: m.recommended ? `${m.label} · Recommended` : m.label }))}
            width={260}
            disabled={locked}
            onChange={(model) => patch({ stt: { ...voice.stt, [stt.id]: { ...voice.stt[stt.id], model } } })}
          />
        ) : null}
        <SelectField
          id="voice-tts"
          title="Speaks with"
          hint={<PrivacyHint text={tts.privacy} local={false} />}
          value={voice.ttsProvider}
          options={ttsOptions}
          width={260}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'ttsProvider')}
          below={voice.ttsProvider === 'auto' ? null : missingKey(tts.key)}
          onChange={(v) => patch({ ttsProvider: v as VoiceSettings['ttsProvider'] })}
        />
        {tts.models.length > 1 ? (
          <SelectField
            id="voice-tts-model"
            title="Voice model"
            nested
            hint={tts.trait}
            value={ttsModel}
            options={tts.models.map((m) => ({ value: m.id, label: m.recommended ? `${m.label} · Recommended` : m.label }))}
            width={260}
            disabled={locked}
            onChange={(model) => patch({ tts: { ...voice.tts, [tts.id]: { ...voice.tts[tts.id], model } } })}
          />
        ) : null}
        <VoicePicker
          provider={tts.id}
          providerLabel={tts.label}
          value={voice.tts[tts.id]?.voiceId ?? ''}
          fallback={tts.defaultVoice}
          speed={clampSpeed(voice.speed, tts.caps.speed)}
          keyReady={keySourceReady(tts.key, keys)}
          keysVersion={JSON.stringify(keys)}
          locked={locked}
          changed={Boolean(voice.tts[tts.id]?.voiceId)}
          onChange={(voiceId) => patch({ tts: { ...voice.tts, [tts.id]: { ...voice.tts[tts.id], voiceId } } })}
        />
        <SegmentedField
          id="voice-speed"
          title="Speaking speed"
          hint={`Kept within what ${tts.label} supports.`}
          value={speedValue}
          options={SPEED_OPTIONS}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'speed')}
          onChange={(v) => patch({ speed: Number(v) })}
        />
        <SelectField
          id="voice-language"
          title="Language"
          hint={stt.caps.languages === 'en' ? `${stt.label} understands English only.` : 'The language you speak in.'}
          value={stt.caps.languages === 'en' ? '' : voice.language}
          options={LANGUAGE_OPTIONS}
          width={200}
          disabled={locked || stt.caps.languages === 'en'}
          {...form.nestedDefaultMark('voice', 'language')}
          onChange={(language) => patch({ language })}
        />
        {fellBack ? (
          <p className="m-0 flex items-center gap-1.5 py-2 text-xs text-muted" role="status">
            <Icon name="warningCircle" size={13} className="text-warning" />
            Until those keys are added, voice mode uses
            {` ${sttResolved.ok ? sttEntry(sttResolved.id).label : '—'} to listen and ${ttsResolved.ok ? ttsEntry(ttsResolved.id).label : '—'} to speak.`}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Voice keys" description="Your own keys, stored encrypted on this PC. One key covers listening and speaking.">
        <SettingsField id="voice-keys" title="Keys" wide>
          <div className="divide-y divide-border/60">
            {VOICE_KEY_VENDORS.map((vendor) => (
              <VendorKeyRow
                key={vendor}
                vendor={vendor}
                state={keyStatus?.voice[vendor]}
                inUse={inUseVendors.has(vendor)}
                locked={locked}
                onChanged={setKeyStatus}
              />
            ))}
            {(['openai', 'openrouter'] as const).map((p) => (
              <div key={p} className="flex min-h-8 items-center gap-3 py-1.5" data-voice-key={p}>
                <span className="w-28 shrink-0 text-sm text-fg">{p === 'openai' ? 'OpenAI' : 'OpenRouter'}</span>
                <span className="min-w-0 flex-1 text-xs">
                  {secrets[p] ? (
                    <span className="inline-flex items-center gap-1.5 text-muted">
                      <Icon name="checkCircle" size={13} />
                      From Providers
                    </span>
                  ) : (
                    <span className="text-tertiary">Not set</span>
                  )}
                </span>
                <Button size="xs" variant="ghost" onClick={() => form.navigateSection('providers')}>
                  Manage in Providers
                </Button>
              </div>
            ))}
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Voice behaviour">
        <SegmentedField
          id="voice-interrupt"
          title="When you talk over it"
          hint="It always stops speaking. This is what happens to the work in progress."
          value={voice.interruptMode}
          options={INTERRUPT_OPTIONS}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'interruptMode')}
          onChange={(interruptMode) => patch({ interruptMode })}
        />
        <SegmentedField
          id="voice-patience"
          title="Turn ending"
          hint="How long it waits after you pause before answering."
          value={voice.endOfTurnPatience}
          options={PATIENCE_OPTIONS}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'endOfTurnPatience')}
          onChange={(endOfTurnPatience) => patch({ endOfTurnPatience })}
        />
        <SwitchField
          id="voice-progress"
          title="Spoken progress"
          hint="A few words when a slow step starts, like “Running the tests.” Off plays a soft sound instead."
          checked={voice.speakProgress}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'speakProgress')}
          onChange={(speakProgress) => patch({ speakProgress })}
        />
        <SwitchField
          id="voice-ptt-only"
          title="Push to talk only"
          hint="Hold Space to talk; it never decides on its own that you’ve finished. Good for noisy rooms."
          checked={voice.pushToTalkOnly}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'pushToTalkOnly')}
          onChange={(pushToTalkOnly) => patch({ pushToTalkOnly })}
        />
        <SwitchField
          id="voice-approve"
          title="Approve by voice"
          hint="Say yes or no to ordinary approvals. Risky actions always need a click."
          checked={voice.approveByVoice}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'approveByVoice')}
          onChange={(approveByVoice) => patch({ approveByVoice })}
        />
        <SwitchField
          id="voice-captions"
          title="Captions"
          hint="Show what it heard and what it’s saying in the voice bar."
          checked={voice.captions}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'captions')}
          onChange={(captions) => patch({ captions })}
        />
        <SwitchField
          id="voice-earcons"
          title="Sounds"
          hint="Short tones when voice mode starts, ends and accepts your turn."
          checked={voice.earcons}
          disabled={locked}
          {...form.nestedDefaultMark('voice', 'earcons')}
          onChange={(earcons) => patch({ earcons })}
        />
      </SettingsGroup>
    </>
  )
}
