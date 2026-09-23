import type { KeyboardEvent } from 'react'
import type { ToolApprovalSettings } from '@shared/ipc'
import { Button, Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { AutoTextarea } from '../components/AutoTextarea'
import { NumberField } from '../components/NumberField'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SettingsNotice } from '../components/SettingsNotice'
import { SwitchField } from '../components/SwitchField'
import { workspaceBadge } from '../components/WorkspaceBadge'
import { workspaceShort } from '../utils/settingsHelpers'
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
        <div className="flex items-center justify-between gap-2 text-2xs text-muted">
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
  // Draft fields remount when the override flips, so they re-seed from the
  // other scope's value instead of carrying the previous scope's text.
  const scopeKey = String(form.workspaceOverrideActive)

  return (
    <SettingsStack>
      {form.workspaceOverrideActive ? (
        <SettingsNotice>
          Override is on for {workspaceShort(form.activeWorkspacePath)}. Rows marked Workspace
          save to that workspace only.
        </SettingsNotice>
      ) : null}

      <SettingsGroup title="Permissions">
        <SelectField
          id="tool-approval"
          title="Tool approval"
          hint="When the agent asks before it runs a tool."
          help="Edits and commands gates tools that change files or run commands; every tool also gates reads. A tool you always allow from an approval prompt skips it from then on."
          badge={scoped}
          value={toolApproval.mode}
          options={TOOL_APPROVAL_OPTIONS}
          disabled={form.formLocked}
          onChange={(mode) => patchApproval({ mode })}
        />
        {toolApproval.allowlist.length > 0 ? (
          <SettingsField
            id="tool-approval-allowlist"
            title="Always allowed"
            hint={`${toolApproval.allowlist.length} ${toolApproval.allowlist.length === 1 ? 'tool skips' : 'tools skip'} approval.`}
            badge={scoped}
            nested
            wide
          >
            <ul className="m-0 flex list-none flex-col divide-y divide-border/60 p-0">
              {toolApproval.allowlist.map((name) => (
                <li key={name} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate font-mono text-xs text-secondary">
                    {name}
                  </span>
                  <Button
                    variant="subtle"
                    aria-label={`Remove ${name}`}
                    disabled={form.formLocked}
                    onClick={() =>
                      patchApproval({
                        allowlist: toolApproval.allowlist.filter((entry) => entry !== name)
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            {toolApproval.allowlist.length > 1 ? (
              // Same edge and weight as the per-tool Remove buttons above it.
              <div className="flex justify-end">
                <Button
                  variant="subtle"
                  disabled={form.formLocked}
                  onClick={() => patchApproval({ allowlist: [] })}
                >
                  Remove all
                </Button>
              </div>
            ) : null}
          </SettingsField>
        ) : null}
        <SwitchField
          id="mcp-tools-protection"
          title="MCP tools protection"
          hint="Always ask before an MCP server tool runs, even with approval off."
          help="Applies to mcp__* server tools. The built-in MCP catalog tools (list, pin, release) follow Tool approval. When off, MCP tools follow Tool approval only."
          badge={scoped}
          checked={toolApproval.mcpProtection !== false}
          disabled={form.formLocked}
          onChange={(mcpProtection) => patchApproval({ mcpProtection })}
        />
        <SwitchField
          id="agent-autonomous-mode"
          title="Autonomous mode"
          hint="For unattended runs: approve gated tools automatically."
          help="High-risk tools still ask. Applies to every workspace."
          checked={form.settings.autonomousMode}
          disabled={form.formLocked}
          onChange={(autonomousMode) => {
            void form.runUpdate({ autonomousMode })
          }}
        />
        <SelectField
          id="agent-autonomous-questions"
          title="Questions in autonomous mode"
          hint="When the agent would stop to ask you something."
          help="Skip moves on without an answer. Wait holds the run until the 15-minute question timeout."
          nested
          value={form.settings.autonomousSkipQuestions}
          options={AUTONOMOUS_QUESTIONS_OPTIONS}
          disabled={form.formLocked || !form.settings.autonomousMode}
          onChange={(autonomousSkipQuestions) => {
            void form.runUpdate({ autonomousSkipQuestions })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Runs">
        <SwitchField
          id="auto-mode-switch"
          title="Automatic mode switching"
          hint="Let the agent move between Ask and Agent as the task changes."
          help="Takes effect from the next step of a live run. When off, only you change the mode — from the composer picker or a slash command."
          checked={form.settings.autoModeSwitch}
          disabled={form.formLocked}
          onChange={(autoModeSwitch) => {
            void form.runUpdate({ autoModeSwitch })
          }}
        />
        <SwitchField
          id="auto-resume-interrupted"
          title="Auto-resume interrupted runs"
          hint="Opening an interrupted chat picks its run back up."
          help="Only the chat you open resumes, not every interrupted run in the workspace. When off, the chat offers Continue instead."
          checked={form.settings.autoResumeInterruptedRuns}
          disabled={form.formLocked}
          onChange={(autoResumeInterruptedRuns) => {
            void form.runUpdate({ autoResumeInterruptedRuns })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Conversation">
        <SwitchField
          id="show-thinking"
          title="Show thinking"
          hint="Collapsed reasoning above replies, when the model returns it."
          badge={scoped}
          checked={showThinking}
          disabled={form.formLocked}
          onChange={(checked) => {
            void form.runAgentUpdate({ showThinking: checked })
          }}
        />
        <NumberField
          id="keep-recent-turns"
          field="keepTurns"
          form={form}
          title="Keep recent turns"
          hint="Turns kept word for word when the context is compacted."
          badge={scoped}
          unit="turns"
          min={4}
          max={50}
          value={form.agentKeepRecentTurns}
          disabled={form.formLocked}
          onCommit={(keepRecentTurns) => {
            void form.runAgentUpdate({ keepRecentTurns })
          }}
        />
        <NumberField
          id="auto-compact-threshold"
          field="autoCompactThreshold"
          form={form}
          title="Auto-compact threshold"
          label="Auto-compact threshold percent"
          hint="How full the context window gets before it is compacted."
          help="At this share of the model's context window the run summarizes older turns — the same as Compact in the context meter."
          badge={scoped}
          unit="%"
          min={5}
          max={95}
          value={form.agentAutoCompactThresholdPct}
          disabled={form.formLocked}
          onCommit={(pct) => {
            void form.runAgentUpdate({ autoCompactThresholdRatio: pct / 100 })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Persona & style">
        <SettingsField
          id="agent-persona"
          title="Name"
          hint="What the agent calls itself."
          help="Leave blank to keep the default assistant name."
          badge={scoped}
        >
          <div className="flex w-full flex-col gap-1 sm:w-72">
            <Input
              className="w-full"
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

        <SettingsField
          id="agent-tone"
          title="Tone"
          hint="How replies sound."
          help="Examples: friendly, blunt, playful, formal. Leave blank for no tone directive."
          badge={scoped}
          wide
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

        <SettingsField
          id="response-language"
          title="Response language"
          hint="Language for replies."
          help="Leave blank to reply in the language you write in."
          badge={scoped}
        >
          <div className="flex w-full flex-col gap-1 sm:w-72">
            <Input
              className="w-full"
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
            <DraftMeta
              value={form.languageDraft}
              max={LANGUAGE_MAX_LENGTH}
              dirty={form.languageDirty}
            />
          </div>
        </SettingsField>

        <SelectField
          id="response-verbosity"
          title="Answer length"
          hint="Default length of conversational replies."
          help="Code and task output are unaffected."
          badge={scoped}
          value={
            form.effectiveChatSettings?.responseVerbosity ??
            form.settings.responseVerbosity ??
            'concise'
          }
          options={RESPONSE_VERBOSITY_OPTIONS}
          disabled={form.formLocked}
          onChange={(responseVerbosity) => {
            void form.runAgentUpdate({ responseVerbosity })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Rules">
        <SettingsField
          id="workspace-rules"
          title="Rules"
          hint="AGENTS.md, CLAUDE.md, .cursorrules, .vyotiq/rules/, and your own."
          help="Rules set to alwaysApply: false are not added to every step; the agent can request them, and you can run them as slash commands. Create one from chat with /create-rule."
        >
          <Button
            variant="subtle"
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
