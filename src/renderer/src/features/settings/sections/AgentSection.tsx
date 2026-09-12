import type {
  AutonomousSkipQuestions,
  OfflineWaitMode,
  ResponseVerbosity
} from '@shared/ipc'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { Input, Menu, Switch } from '@renderer/lib/ui'
import { AutoTextarea } from '../components/AutoTextarea'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import {
  AUTONOMOUS_QUESTIONS_OPTIONS,
  LANGUAGE_MAX_LENGTH,
  OFFLINE_WAIT_OPTIONS,
  PERSONA_MAX_LENGTH,
  RESPONSE_LANGUAGE_SUGGESTIONS,
  RESPONSE_VERBOSITY_OPTIONS,
  TONE_MAX_LENGTH
} from '../constants'

/** Counter + save-status line under the persona/tone textareas. */
function DraftMeta({ value, max, dirty }: { value: string; max: number; dirty: boolean }) {
  const edgeWhitespace = value.length > 0 && value.trim() !== value
  return (
    <div className="flex items-center justify-between gap-2 text-2xs text-muted">
      <span aria-live="polite">
        {dirty
          ? 'Unsaved — saved when you leave the field'
          : edgeWhitespace
            ? 'Extra spaces at the start/end are removed on save'
            : ''}
      </span>
      <span className="tabular-nums">
        {value.length}/{max}
      </span>
    </div>
  )
}

export function AgentSection({ form }: { form: SettingsFormState }) {
  const showThinking =
    form.effectiveChatSettings?.showThinking ?? form.settings.showThinking

  return (
    <SettingsStack>
      {form.workspaceOverrideActive ? (
        <p className="m-0 rounded-xl bg-surface px-4 py-3 text-xs text-secondary">
          Workspace override on — persona &amp; style, show thinking, and keep recent turns apply
          to this workspace only. Tool approval (Settings → Tools) also honors this override.
          Shell, search engine, browser domain allowlist, automatic mode switching, autonomy,
          and run budget stay app-wide.
        </p>
      ) : null}

      <SettingsGroup title="Chat">
        <SettingsField
          id="show-thinking"
          title="Show thinking in chat"
          hint="Collapsed thinking blocks above assistant replies."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : 'Shown when the model returns reasoning content.'
          }
        >
          <Switch
            size="md"
            checked={showThinking}
            disabled={form.formLocked}
            label={
              form.workspaceOverrideActive
                ? 'Show thinking in chat for this workspace'
                : 'Show thinking in chat'
            }
            onCheckedChange={(checked) => {
              void form.runAgentUpdate({ showThinking: checked })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Persona & style">
        <SettingsField
          id="agent-persona"
          title="Persona"
          hint="Assistant identity the agent claims in replies."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : 'Leave blank to keep the default Agent V identity. Per-workspace via Workspace Override.'
          }
          wide
        >
          <div className="flex w-full flex-col gap-1.5">
            <AutoTextarea
              placeholder="e.g. Nova — a terse, senior pair programmer"
              aria-label="Persona"
              maxLength={PERSONA_MAX_LENGTH}
              maxRows={6}
              disabled={form.formLocked}
              value={form.personaDraft}
              key={`agent-persona-${form.workspaceOverrideActive}`}
              onChange={(e) => {
                form.setPersonaDraft(e.target.value)
              }}
              onBlur={() => {
                void form.persistPersona()
              }}
            />
            <DraftMeta
              value={form.personaDraft}
              max={PERSONA_MAX_LENGTH}
              dirty={form.personaDirty}
            />
          </div>
        </SettingsField>

        <SettingsField
          id="agent-tone"
          title="Tone"
          hint="How replies sound — free-form description."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : 'Examples: friendly, blunt, playful, formal. Leave blank for the default tone.'
          }
          wide
        >
          <div className="flex w-full flex-col gap-1.5">
            <AutoTextarea
              placeholder="Friendly, direct, playful…"
              aria-label="Tone"
              maxLength={TONE_MAX_LENGTH}
              maxRows={6}
              disabled={form.formLocked}
              value={form.toneDraft}
              key={`agent-tone-${form.workspaceOverrideActive}`}
              onChange={(e) => {
                form.setToneDraft(e.target.value)
              }}
              onBlur={() => {
                void form.persistTone()
              }}
            />
            <DraftMeta value={form.toneDraft} max={TONE_MAX_LENGTH} dirty={form.toneDirty} />
          </div>
        </SettingsField>

        <SettingsField
          id="response-language"
          title="Response language"
          hint="Preferred language for replies."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : "Leave blank to follow your language."
          }
        >
          <div className="flex w-full flex-col gap-1 sm:w-72">
            <Input
              className="w-full"
              placeholder="e.g. Spanish, 日本語, Deutsch"
              aria-label="Response language"
              maxLength={LANGUAGE_MAX_LENGTH}
              list="response-language-options"
              disabled={form.formLocked}
              value={form.languageDraft}
              key={`response-language-${form.workspaceOverrideActive}`}
              onChange={(e) => {
                form.setLanguageDraft(e.target.value)
              }}
              onBlur={() => {
                void form.persistLanguage()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
            <datalist id="response-language-options">
              {RESPONSE_LANGUAGE_SUGGESTIONS.map((language) => (
                <option value={language} key={language} />
              ))}
            </datalist>
            <DraftMeta
              value={form.languageDraft}
              max={LANGUAGE_MAX_LENGTH}
              dirty={form.languageDirty}
            />
          </div>
        </SettingsField>

        <SettingsField
          id="response-verbosity"
          title="Answer length"
          hint="Default length for conversational replies."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : 'Concise is the default; code and task output is unaffected.'
          }
        >
          <Menu
            aria-label="Answer length"
            value={
              form.effectiveChatSettings?.responseVerbosity ??
              form.settings.responseVerbosity ??
              'concise'
            }
            options={RESPONSE_VERBOSITY_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => {
              void form.runAgentUpdate({ responseVerbosity: v as ResponseVerbosity })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Compaction">
        <SettingsField
          id="keep-recent-turns"
          title="Keep recent turns"
          hint="Turns preserved during compaction (4–50)."
          help="Compaction keeps this many recent conversation turns when context is trimmed."
        >
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              className="w-24"
              aria-label="Keep recent turns"
              min={4}
              max={50}
              disabled={form.formLocked}
              defaultValue={form.agentKeepRecentTurns}
              key={`keep-turns-${form.agentKeepRecentTurns}-${form.workspaceOverrideActive}`}
              aria-invalid={form.errorField === 'keepTurns' ? true : undefined}
              aria-describedby={form.errorField === 'keepTurns' ? 'keep-turns-error' : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => {
                form.commitNumberField('keepTurns', e.target, {
                  label: 'Keep recent turns',
                  min: 4,
                  max: 50,
                  integer: true,
                  current: form.agentKeepRecentTurns,
                  apply: (keepRecentTurns) => ({ keepRecentTurns }),
                  persist: (partial) => {
                    void form.runAgentUpdate(partial)
                  }
                })
              }}
            />
            <span className="text-xs text-secondary">turns</span>
          </div>
          {form.fieldError.keepTurns}
        </SettingsField>

        <SettingsField
          id="auto-compact-threshold"
          title="Auto-compact threshold"
          hint="Percent of the model content window that triggers auto-compact (5–95)."
          help="When estimated context reaches this share of the content window, the loop runs the same summarizer as Compact in the context meter."
        >
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              className="w-24"
              aria-label="Auto-compact threshold percent"
              min={5}
              max={95}
              disabled={form.formLocked}
              defaultValue={form.agentAutoCompactThresholdPct}
              key={`auto-compact-${form.agentAutoCompactThresholdPct}-${form.workspaceOverrideActive}`}
              aria-invalid={form.errorField === 'autoCompactThreshold' ? true : undefined}
              aria-describedby={
                form.errorField === 'autoCompactThreshold' ? 'auto-compact-threshold-error' : undefined
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => {
                form.commitNumberField('autoCompactThreshold', e.target, {
                  label: 'Auto-compact threshold',
                  min: 5,
                  max: 95,
                  integer: true,
                  current: form.agentAutoCompactThresholdPct,
                  apply: (pct) => ({ autoCompactThresholdRatio: pct / 100 }),
                  persist: (partial) => {
                    void form.runAgentUpdate(partial)
                  }
                })
              }}
            />
            <span className="text-xs text-secondary">%</span>
          </div>
          {form.fieldError.autoCompactThreshold}
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Autonomy & budget">
        <SettingsField
          id="agent-autonomous-mode"
          title="Autonomous mode"
          hint="Unattended runs: auto-approve gated tools (high-risk stays gated)."
          help="Also relaxes offline waiting per the wait budget below. Off by default."
        >
          <Switch
            size="md"
            checked={form.settings.autonomousMode}
            disabled={form.formLocked}
            label="Autonomous mode"
            onCheckedChange={(checked) => {
              void form.runUpdate({ autonomousMode: checked })
            }}
          />
        </SettingsField>

        <SettingsField
          id="agent-autonomous-questions"
          title="Questions in autonomous mode"
          hint="What the agent does when it would ask a question mid-run."
          help="Skip ends the ask immediately; wait holds the run until the 15-minute question timeout."
        >
          <Menu
            aria-label="Questions in autonomous mode"
            value={form.settings.autonomousSkipQuestions}
            options={AUTONOMOUS_QUESTIONS_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !form.settings.autonomousMode}
            onChange={(v) => {
              void form.runUpdate({ autonomousSkipQuestions: v as AutonomousSkipQuestions })
            }}
          />
        </SettingsField>

        <SettingsField
          id="agent-offline-wait"
          title="Offline wait budget"
          hint="How long unattended runs wait out a lost connection."
          help="Wait indefinitely requires autonomous mode; otherwise the default budget applies."
        >
          <Menu
            aria-label="Offline wait budget"
            value={form.settings.offlineWaitMode}
            options={OFFLINE_WAIT_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => {
              void form.runUpdate({ offlineWaitMode: v as OfflineWaitMode })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Reference">
        <SettingsField
          id="workspace-rules"
          title="Workspace rules"
          hint="Loaded from AGENTS.md, CLAUDE.md, .cursorrules, and .vyotiq/rules/."
          help="Create and edit user and project rules in Marketplace → Manage → Rules. Rules with alwaysApply: false stay requestable (slash) and are not auto-injected."
          wide
        >
          <p className="m-0 text-xs text-secondary">
            Open Marketplace → Manage → Rules, or use <code className="text-caption">/create-rule</code> in
            chat.
          </p>
        </SettingsField>

        <SettingsField
          id="memory-files"
          title="Memory files"
          hint="Long-term memory under .vyotiq/memory/ (plain markdown)."
          help="Use memory_* tools in Agent mode for durable facts. Not embedding RAG — facts are markdown files in the workspace. Use codebase_search for semantic code retrieval (local LightOn dense ONNX index in app userData; Ollama/hash overrides)."
          wide
        >
          <p className="m-0 text-xs text-secondary">index.md, state.md, and notes/ in the workspace.</p>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
