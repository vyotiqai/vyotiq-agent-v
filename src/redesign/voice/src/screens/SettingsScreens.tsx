import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Badge, Button, FormGroup, FormRow, FormStack, IconButton, Keys, ProgressBar, Segmented, Switch, cn, selectTriggerClass } from '@renderer/lib/ui'
import { SIDEBAR_WIDTH_PX } from '@renderer/lib/utils/layout'
import { SettingsIndex } from '@renderer/features/settings/components/SettingsNav'
import { VIcon } from '../lib/icons'
import { Panel, Window } from '../shell/Window'
import { LiveMeter } from '../voice/Meter'
import { ENGINES, type Engine } from '../voice/Take'

/*
  Settings → Voice, rebuilt on the real FormGroup / FormRow grammar.

  Before: an engine switch whose "Local" option was disabled until you found
  the install rows under it; model state spread over a hint, a right-hand word,
  two buttons and an overflow menu; "In use" shown for a local model while a
  cloud engine was selected; a whole Composer group for four waveform styles.

  After: where the audio goes (one choice, never disabled), the model only when
  it applies, the microphone with a live level, and how a take starts and ends.
*/

function Select({ value, disabled = false }: { value: string; disabled?: boolean }) {
  return (
    <span className={cn(selectTriggerClass(), 'w-[260px]', disabled && 'vy-disabled-state')} aria-disabled={disabled || undefined}>
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <Icon name="chevron" size={11} className="shrink-0 text-tertiary" />
    </span>
  )
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('grid size-4 shrink-0 place-items-center rounded-full border', on ? 'border-accent' : 'border-border-strong')}
    >
      {on ? <span className="size-2 rounded-full bg-accent" /> : null}
    </span>
  )
}

/** One Whisper model: pick it, and see what it costs on disk and in memory. */
function ModelRow({
  on,
  name,
  meta,
  badge,
  action
}: {
  on: boolean
  name: string
  meta: ReactNode
  badge?: ReactNode
  action: ReactNode
}) {
  return (
    <div className={cn('flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5', on ? 'bg-surface-2' : 'hover:bg-surface')} role="radio" aria-checked={on}>
      <Radio on={on} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm text-fg-strong">
          {name}
          {badge}
        </div>
        <div className="mt-0.5 text-xs text-muted">{meta}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">{action}</div>
    </div>
  )
}

function Privacy({ engine }: { engine: Engine }) {
  const e = ENGINES[engine]
  return (
    <span className="inline-flex items-center gap-1.5">
      <VIcon name={e.icon} size={13} className="text-tertiary" />
      {e.privacy}
    </span>
  )
}

function VoicePage({ engine, installing = null }: { engine: Engine; installing?: number | null }) {
  const local = engine === 'local'
  const noKey = engine === 'openai'
  return (
    <FormStack>
      <FormGroup title="Dictation" description="Speak a brief or an instruction; the words land at the cursor.">
        <FormRow
          id="voice-engine"
          title="Runs on"
          hint={<Privacy engine={engine} />}
          changed={local}
          onReset={() => undefined}
          below={
            noKey ? (
              <div className="flex items-center gap-2 text-xs text-danger" role="alert">
                <Icon name="warningCircle" size={13} />
                <span className="flex-1">No OpenAI key yet — the mic cannot start.</span>
                <Button size="xs" variant="secondary" icon="key">
                  Add key
                </Button>
              </div>
            ) : null
          }
        >
          <Segmented
            value={engine}
            label="Runs on"
            items={[
              { id: 'local', label: 'This PC', icon: 'lock' },
              { id: 'openai', label: 'OpenAI' },
              { id: 'openrouter', label: 'OpenRouter' }
            ]}
          />
        </FormRow>
        {local ? (
          <FormRow id="voice-model" title="Model" hint="Both run offline once downloaded. Switching is instant." wide>
            <div className="-mx-2 space-y-px" role="radiogroup" aria-label="Model">
              <ModelRow
                on
                name="Whisper Small"
                badge={<Badge tone="outline">Best for this PC</Badge>}
                meta={
                  <>
                    <span className="font-mono tnum">249 MB</span> on disk · loaded, <span className="font-mono tnum">610 MB</span> of memory
                  </>
                }
                action={<IconButton icon="more" label="More for Whisper Small" size="sm" tone="muted" />}
              />
              <ModelRow
                on={false}
                name="Whisper Tiny"
                meta={
                  installing != null ? (
                    <span className="flex items-center gap-2">
                      <ProgressBar value={installing} tone="accent" className="w-40" label="Whisper Tiny download" />
                      <span className="font-mono tnum">{`${Math.round(41 * installing)} / 41 MB`}</span>
                    </span>
                  ) : (
                    <>
                      <span className="font-mono tnum">41 MB</span> · faster, less accurate · for under 8 GB of memory
                    </>
                  )
                }
                action={
                  installing != null ? (
                    <Button size="xs" variant="ghost">
                      Cancel
                    </Button>
                  ) : (
                    <Button size="xs" variant="secondary" icon="download">
                      Install
                    </Button>
                  )
                }
              />
            </div>
          </FormRow>
        ) : null}
        <FormRow id="voice-language" title="Language" hint={local ? 'This PC understands English only.' : 'Detected as you speak.'}>
          <Select value={local ? 'English' : 'Detect automatically'} disabled={local} />
        </FormRow>
      </FormGroup>

      <FormGroup title="Microphone">
        <FormRow
          id="voice-input"
          title="Input"
          hint="Follows the Windows default unless you pick one."
          below={
            <div className="flex items-center gap-3">
              <LiveMeter seed={29} />
              <span className="text-xs text-tertiary">Speak — the bars should move</span>
            </div>
          }
        >
          <Select value="Microphone Array (Realtek)" />
        </FormRow>
      </FormGroup>

      <FormGroup title="Controls">
        <FormRow id="voice-shortcut" title="Shortcut" hint="Starts a take anywhere a brief or instruction can be typed.">
          <span className="flex items-center gap-2">
            <Keys keys={['Ctrl', 'M']} />
            <Button size="xs" variant="ghost">
              Change
            </Button>
          </span>
        </FormRow>
        <FormRow id="voice-hold" title="Hold to talk" hint="Hold the shortcut while you speak; letting go inserts. A tap still starts and stops a take.">
          <Switch checked onCheckedChange={() => undefined} label="Hold to talk" />
        </FormRow>
        <FormRow id="voice-after" title="Enter ends a take by" hint="Ctrl+Enter does the other one.">
          <Segmented
            value="insert"
            label="Enter ends a take by"
            items={[
              { id: 'insert', label: 'Inserting' },
              { id: 'send', label: 'Sending' }
            ]}
          />
        </FormRow>
      </FormGroup>
    </FormStack>
  )
}

function SettingsFrame({ engine, installing }: { engine: Engine; installing?: number | null }) {
  const changed = engine === 'local' ? 1 : 0
  return (
    <Window
      navigator={
        <div className="flex h-full shrink-0 flex-col bg-chrome" style={{ width: SIDEBAR_WIDTH_PX }}>
          <SettingsIndex
            section="voice"
            onSectionChange={() => undefined}
            backLabel="Retry uploads on flaky networks"
            onBack={() => undefined}
            search={
              <div className="flex h-7 items-center gap-2 rounded-md bg-surface px-2 text-xs text-tertiary">
                <Icon name="search" size={13} />
                Search settings
              </div>
            }
          />
        </div>
      }
    >
      <Panel>
        <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border pl-4 pr-2">
          <h1 className="m-0 shrink-0 text-sm font-semibold text-fg-strong">Voice</h1>
          <p className="m-0 min-w-0 truncate text-xs text-tertiary">Dictation for briefs and instructions</p>
          <span className="flex-1" />
          {changed > 0 ? (
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
              {changed} changed from default
              <Button size="xs" variant="ghost">
                Reset section
              </Button>
            </span>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="w-full max-w-[800px] px-10 pb-16 pt-2">
            <VoicePage engine={engine} installing={installing} />
          </div>
        </div>
      </Panel>
    </Window>
  )
}

export function SettingsLocal() {
  return <SettingsFrame engine="local" />
}

export function SettingsInstalling() {
  return <SettingsFrame engine="local" installing={0.46} />
}

export function SettingsCloudNoKey() {
  return <SettingsFrame engine="openai" />
}
