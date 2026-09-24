import type { KeyboardEvent } from 'react'
import type { ToolApprovalSettings } from '@shared/ipc'
import { Icon } from '@renderer/lib/icons'
import { Button, Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { AutoTextarea } from '../components/AutoTextarea'
import { NumberField } from '../components/NumberField'
import { SegmentedField } from '../components/SegmentedField'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'
import { workspaceBadge } from '../components/WorkspaceBadge'
import {
  AUTONOMOUS_QUESTIONS_OPTIONS,
  IDENTITY_MAX_LENGTH,
  LANGUAGE_MAX_LENGTH,
  PERSONA_MAX_LENGTH,
  RESPONSE_LANGUAGE_SUGGESTIONS,
  RESPONSE_VERBOSITY_OPTIONS,
  TONE_MAX_LENGTH,
  TOOL_APPROVAL_OPTIONS
} from '../constants'

/**
 * Save state under a persona/tone text field. Silent until it has something
 * to say: four permanent "0/1000" counters under empty fields were four lines
 * of noise, and `maxLength` already stops typing at the limit — the count only
 * matters once you are close to it.
 *
 * The status is announced from a live region that stays mounted (one that
 * appears together with its text is never read out) and sits outside the
 * layout, so an idle field adds no gap. The visible copy is hidden from
 * assistive tech so the status is not read twice.
 */
function DraftMeta({ value, max, dirty }: { value: string; max: number; dirty: boolean }) {
  const edgeWhitespace = value.length > 0 && value.trim() !== value
  const nearLimit = value.length >= max * 0.8
  const status = dirty
    ? 'Unsaved — saved when you leave the field'
    : edgeWhitespace
      ? 'Extra spaces at the start/end are removed on save'
      : ''
  return (
    <>
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
      {status || nearLimit ? (
        <div className="flex w-full items-center justify-between gap-2 text-caption text-tertiary">
          <span aria-hidden="true">{status}</span>
          {nearLimit ? (
            <span className="tabular-nums">
              {value.length}/{max}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function blurOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.currentTarget.blur()
  }
}

/** The tools that no longer ask, as chips that each take themselves off the list. */
function AllowedTools({
  names,
  disabled,
  onRemove,
  onRemoveAll
}: {
  names: string[]
  disabled: boolean
  onRemove: (name: string) => void
  onRemoveAll: () => void
}) {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0" aria-label="Always allowed tools">
      {names.map((name) => (
        <li
          key={name}
          className="inline-flex h-6 items-center gap-1.5 rounded-md bg-surface pl-2 pr-1 font-mono text-caption text-secondary"
        >
          {name}
          <button
            type="button"
            aria-label={`Remove ${name}`}
            disabled={disabled}
            className="grid size-4 place-items-center rounded-sm text-tertiary vy-transition hover:bg-surface-2 hover:text-fg focus-visible:vy-focus-ring disabled:vy-disabled-state"
            onClick={() => onRemove(name)}
          >
            <Icon name="close" size={10} />
          </button>
        </li>
      ))}
      {names.length > 1 ? (
        <li>
          <Button size="xs" variant="ghost" disabled={disabled} onClick={onRemoveAll}>
            Remove all
          </Button>
        </li>
      ) : null}
    </ul>
  )
}

export function AgentSection({
  form,
  onOpenMarketplace
}: {
  form: SettingsFormState
  onOpenMarketplace?: SettingsViewProps['onOpenMarketplace']
}) {
  const scoped = workspaceBadge(form.workspaceOverrideActive)
  const toolApproval = form.toolApproval
  const patchApproval = (patch: Partial<ToolApprovalSettings>): void => {
    void form.runAgentUpdate({ toolApproval: { ...toolApproval, ...patch } })
  }
  const showThinking = form.effectiveChatSettings?.showThinking ?? form.settings.showThinking
  const verbosity =
    form.effectiveChatSettings?.responseVerbosity ?? form.settings.responseVerbosity ?? 'concise'
  // Draft fields remount when the override flips, so they re-seed from the
  // other scope's value instead of carrying the previous scope's text.
  const scopeKey = String(form.workspaceOverrideActive)
  const allowed = toolApproval.allowlist

  return (
    <SettingsStack>
      <SettingsGroup title="Approvals">
        <SelectField
          id="tool-approval"
          title="Ask before"
          hint="The agent pauses for you before these run."
          help="Edits and commands covers tools that change files or run commands; every tool adds reads. A tool you always allow from an approval prompt stops asking."
          badge={scoped}
          icon="shield"
          value={toolApproval.mode}
          options={TOOL_APPROVAL_OPTIONS}
          disabled={form.formLocked}
          onChange={(mode) => patchApproval({ mode })}
          {...form.agentDefaultMark('toolApproval', 'mode')}
        />
        {/* The list grows from approval prompts; it is a record, not a
            preference, so it carries no changed mark and Reset leaves it. */}
        <SettingsField
          id="tool-approval-allowlist"
          title="Always allowed"
          hint={
            allowed.length > 0
              ? 'Tools you allowed for good. Remove one to be asked again.'
              : 'None yet. Always allow on an approval adds the tool here.'
          }
          badge={scoped}
          below={
            allowed.length > 0 ? (
              <AllowedTools
                names={allowed}
                disabled={form.formLocked}
                onRemove={(name) => patchApproval({ allowlist: allowed.filter((entry) => entry !== name) })}
                onRemoveAll={() => patchApproval({ allowlist: [] })}
              />
            ) : null
          }
        />
        <SwitchField
          id="mcp-tools-protection"
          title="MCP tools always ask"
          hint="Even when approvals are off."
          help="Applies to tools from MCP servers. The built-in MCP catalog tools (list, pin, release) follow Ask before."
          badge={scoped}
          checked={toolApproval.mcpProtection !== false}
          disabled={form.formLocked}
          onChange={(mcpProtection) => patchApproval({ mcpProtection })}
          {...form.agentDefaultMark('toolApproval', 'mcpProtection')}
        />
        <SwitchField
          id="agent-autonomous-mode"
          title="Unattended mode"
          hint="Approve gated tools automatically, except high-risk ones. For runs nobody is watching."
          help="Applies to every workspace."
          checked={form.settings.autonomousMode}
          disabled={form.formLocked}
          onChange={(autonomousMode) => {
            void form.runUpdate({ autonomousMode })
          }}
          {...form.defaultMark('autonomousMode')}
        />
        <SelectField
          id="agent-autonomous-questions"
          title="Questions while unattended"
          help="Skip moves on without an answer. Wait holds the run until the 15-minute question timeout."
          nested
          value={form.settings.autonomousSkipQuestions}
          options={AUTONOMOUS_QUESTIONS_OPTIONS}
          disabled={form.formLocked || !form.settings.autonomousMode}
          onChange={(autonomousSkipQuestions) => {
            void form.runUpdate({ autonomousSkipQuestions })
          }}
          {...form.defaultMark('autonomousSkipQuestions')}
        />
      </SettingsGroup>

      <SettingsGroup title="Runs">
        <SwitchField
          id="auto-mode-switch"
          title="Switch between Ask and Agent on its own"
          help="Takes effect from the next step of a live run. When off, only you change the mode — from the composer or a slash command."
          checked={form.settings.autoModeSwitch}
          disabled={form.formLocked}
          onChange={(autoModeSwitch) => {
            void form.runUpdate({ autoModeSwitch })
          }}
          {...form.defaultMark('autoModeSwitch')}
        />
        <SwitchField
          id="auto-resume-interrupted"
          title="Resume interrupted runs"
          hint="Opening an interrupted task picks its run back up."
          help="Only the task you open resumes, not every interrupted run in the workspace. When off, the task offers Continue instead."
          checked={form.settings.autoResumeInterruptedRuns}
          disabled={form.formLocked}
          onChange={(autoResumeInterruptedRuns) => {
            void form.runUpdate({ autoResumeInterruptedRuns })
          }}
          {...form.defaultMark('autoResumeInterruptedRuns')}
        />
      </SettingsGroup>

      <SettingsGroup title="Record">
        <SwitchField
          id="show-thinking"
          title="Show reasoning"
          hint="Folded notes under each step, when the model returns them."
          badge={scoped}
          checked={showThinking}
          disabled={form.formLocked}
          onChange={(checked) => {
            void form.runAgentUpdate({ showThinking: checked })
          }}
          {...form.agentDefaultMark('showThinking')}
        />
        <NumberField
          id="keep-recent-turns"
          field="keepTurns"
          form={form}
          title="Keep recent turns"
          hint="Kept word for word when the context is compacted."
          badge={scoped}
          unit="turns"
          min={4}
          max={50}
          value={form.agentKeepRecentTurns}
          disabled={form.formLocked}
          onCommit={(keepRecentTurns) => {
            void form.runAgentUpdate({ keepRecentTurns })
          }}
          {...form.agentDefaultMark('keepRecentTurns')}
        />
        <NumberField
          id="auto-compact-threshold"
          field="autoCompactThreshold"
          form={form}
          title="Compact at"
          label="Compact at, percent of context"
          help="At this share of the model's context window the run summarises older turns — the same as Compact in the context meter."
          badge={scoped}
          unit="% of context"
          min={5}
          max={95}
          value={form.agentAutoCompactThresholdPct}
          disabled={form.formLocked}
          onCommit={(pct) => {
            void form.runAgentUpdate({ autoCompactThresholdRatio: pct / 100 })
          }}
          {...form.agentDefaultMark('autoCompactThresholdRatio')}
        />
      </SettingsGroup>

      <SettingsGroup title="Voice">
        <SegmentedField
          id="response-verbosity"
          title="Answer length"
          help="Default length of conversational replies. Code and task output are unaffected."
          badge={scoped}
          value={verbosity}
          options={RESPONSE_VERBOSITY_OPTIONS}
          disabled={form.formLocked}
          onChange={(responseVerbosity) => {
            void form.runAgentUpdate({ responseVerbosity })
          }}
          {...form.agentDefaultMark('responseVerbosity')}
        />
        <SettingsField
          id="response-language"
          title="Response language"
          help="Leave blank to reply in the language you write in."
          badge={scoped}
          {...form.agentDefaultMark('responseLanguage')}
        >
          <div className="flex w-[180px] flex-col items-end gap-1">
            <Input
              size="sm"
              placeholder="Same as yours"
              aria-label="Response language"
              maxLength={LANGUAGE_MAX_LENGTH}
              list="response-language-options"
              disabled={form.formLocked}
              value={form.languageDraft}
              key={`response-language-${scopeKey}`}
              onChange={(e) => form.setLanguageDraft(e.target.value)}
              onBlur={() => {
                void form.persistLanguage()
              }}
              onKeyDown={blurOnEnter}
            />
            <datalist id="response-language-options">
              {RESPONSE_LANGUAGE_SUGGESTIONS.map((language) => (
                <option value={language} key={language} />
              ))}
            </datalist>
            <DraftMeta value={form.languageDraft} max={LANGUAGE_MAX_LENGTH} dirty={form.languageDirty} />
          </div>
        </SettingsField>
        <SettingsField
          id="agent-tone"
          title="Tone"
          hint="How replies sound."
          help="Friendly, blunt, playful, formal. Leave blank for no tone directive."
          badge={scoped}
          wide
          {...form.agentDefaultMark('agentTone')}
        >
          <AutoTextarea
            placeholder="e.g. Blunt and concise; lead with the outcome."
            aria-label="Tone"
            maxLength={TONE_MAX_LENGTH}
            maxRows={6}
            disabled={form.formLocked}
            value={form.toneDraft}
            key={`agent-tone-${scopeKey}`}
            onChange={(e) => form.setToneDraft(e.target.value)}
            onBlur={() => {
              void form.persistTone()
            }}
          />
          <DraftMeta value={form.toneDraft} max={TONE_MAX_LENGTH} dirty={form.toneDirty} />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Persona">
        <SettingsField
          id="agent-persona"
          title="Name"
          hint="What the agent calls itself."
          help="Leave blank to keep the default assistant name."
          badge={scoped}
          {...form.agentDefaultMark('agentPersona')}
        >
          <div className="flex w-[180px] flex-col items-end gap-1">
            <Input
              size="sm"
              placeholder="e.g. Nova"
              aria-label="Name"
              maxLength={PERSONA_MAX_LENGTH}
              disabled={form.formLocked}
              value={form.personaDraft}
              key={`agent-persona-${scopeKey}`}
              onChange={(e) => form.setPersonaDraft(e.target.value)}
              onBlur={() => {
                void form.persistPersona()
              }}
              onKeyDown={blurOnEnter}
            />
            <DraftMeta value={form.personaDraft} max={PERSONA_MAX_LENGTH} dirty={form.personaDirty} />
          </div>
        </SettingsField>
        <SettingsField
          id="agent-identity"
          title="Identity"
          hint="Who the agent is: its role and how it works."
          help="Added to the agent's instructions as written. Leave blank for none."
          badge={scoped}
          wide
          {...form.agentDefaultMark('agentIdentity')}
        >
          <AutoTextarea
            placeholder="e.g. Reads the code before acting; reports what it verified separately from what it assumes."
            aria-label="Identity"
            maxLength={IDENTITY_MAX_LENGTH}
            maxRows={6}
            disabled={form.formLocked}
            value={form.identityDraft}
            key={`agent-identity-${scopeKey}`}
            onChange={(e) => form.setIdentityDraft(e.target.value)}
            onBlur={() => {
              void form.persistIdentity()
            }}
          />
          <DraftMeta value={form.identityDraft} max={IDENTITY_MAX_LENGTH} dirty={form.identityDirty} />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Rules">
        <SettingsField
          id="workspace-rules"
          title="Rules"
          hint="AGENTS.md, CLAUDE.md, .cursorrules, .vyotiq/rules/, and your own."
          help="Rules set to alwaysApply: false are not added to every step; the agent can request them, and you can run them as slash commands. Create one from a task with /create-rule."
        >
          <Button
            size="sm"
            variant="secondary"
            trailingIcon="arrowRight"
            disabled={!onOpenMarketplace}
            onClick={() => onOpenMarketplace?.('rules')}
          >
            Manage rules
          </Button>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
