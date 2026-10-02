import { useState, type KeyboardEvent } from 'react'
import type { PermissionRule, PermissionRuleEffect } from '@shared/ipc'
import {
  DEFAULT_ASK_PATHS,
  PROTECTED_PATH_NOTES,
  type PermissionRuleKind
} from '@shared/permissionRules'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button, IconButton, Input, Segmented } from '@renderer/lib/ui'

const EFFECTS: ReadonlyArray<{ id: PermissionRuleEffect; label: string }> = [
  { id: 'allow', label: 'Allow' },
  { id: 'ask', label: 'Ask' },
  { id: 'deny', label: 'Deny' }
]

const KINDS: ReadonlyArray<{ id: PermissionRuleKind; label: string; icon: IconName }> = [
  { id: 'path', label: 'Path', icon: 'file' },
  { id: 'command', label: 'Command', icon: 'terminal' },
  { id: 'tool', label: 'Tool', icon: 'tool' }
]

const KIND_ICON: Record<PermissionRuleKind, IconName> = { path: 'file', command: 'terminal', tool: 'tool' }

const PLACEHOLDER: Record<PermissionRuleKind, string> = {
  path: 'src/generated/** or ~/notes/**',
  command: 'git push',
  tool: 'browser_* or mcp__github__*'
}

/** Everything a rule matches on, in the order it is checked. */
function ruleMatchers(rule: PermissionRule): Array<{ kind: PermissionRuleKind; text: string }> {
  const out: Array<{ kind: PermissionRuleKind; text: string }> = []
  if (rule.tool) out.push({ kind: 'tool', text: rule.tool })
  if (rule.command) out.push({ kind: 'command', text: rule.command })
  if (rule.path) out.push({ kind: 'path', text: rule.path })
  return out
}

function makeRule(effect: PermissionRuleEffect, kind: PermissionRuleKind, text: string): PermissionRule {
  if (kind === 'path') return { effect, path: text }
  if (kind === 'command') return { effect, command: text }
  return { effect, tool: text }
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.effect === b.effect && a.tool === b.tool && a.command === b.command && a.path === b.path
}

/**
 * Settings → Agent → Permission rules: one row per rule (what it does, what it
 * matches, remove), a row to add one, and the protections no rule changes.
 * Rows edit their effect in place; to change what a rule matches, remove it
 * and add the new one.
 */
export function PermissionRulesEditor({
  rules,
  disabled,
  onChange
}: {
  rules: readonly PermissionRule[]
  disabled: boolean
  onChange: (rules: PermissionRule[]) => void
}) {
  const [kind, setKind] = useState<PermissionRuleKind>('path')
  const [effect, setEffect] = useState<PermissionRuleEffect>('deny')
  const [pattern, setPattern] = useState('')
  const draft = pattern.trim()
  const duplicate = draft !== '' && rules.some((rule) => sameRule(rule, makeRule(effect, kind, draft)))
  const canAdd = !disabled && draft !== '' && !duplicate

  const add = (): void => {
    if (!canAdd) return
    onChange([...rules, makeRule(effect, kind, draft)])
    setPattern('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      add()
    }
  }

  return (
    <div className="flex flex-col gap-2" data-permission-rules="">
      {rules.length > 0 ? (
        <ul className="m-0 grid list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 p-0" aria-label="Permission rules">
          {rules.map((rule, index) => {
            const matchers = ruleMatchers(rule)
            const label = matchers.map((m) => `${m.kind} ${m.text}`).join(', ')
            return (
              <li key={`${index}:${rule.effect}:${label}`} className="contents">
                <Segmented
                  size="xs"
                  label={`Effect of ${label}`}
                  value={rule.effect}
                  items={EFFECTS}
                  disabled={disabled}
                  onChange={(next) => {
                    if (next === rule.effect) return
                    onChange(rules.map((r, i) => (i === index ? { ...r, effect: next } : r)))
                  }}
                />
                <span className="flex min-w-0 items-center gap-2 font-mono text-caption text-secondary" title={label}>
                  {matchers.map((m) => (
                    <span key={m.kind} className="inline-flex min-w-0 items-center gap-1">
                      <Icon name={KIND_ICON[m.kind]} size={11} className="shrink-0 text-tertiary" aria-label={m.kind} />
                      <span className="truncate">{m.text}</span>
                    </span>
                  ))}
                </span>
                <IconButton
                  size="xs"
                  tone="muted"
                  icon="close"
                  label={`Remove rule: ${rule.effect} ${label}`}
                  disabled={disabled}
                  onClick={() => onChange(rules.filter((_, i) => i !== index))}
                />
              </li>
            )
          })}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Segmented label="New rule matches" value={kind} items={KINDS} disabled={disabled} onChange={setKind} />
        <div className="min-w-[160px] flex-1">
          <Input
            size="sm"
            mono
            aria-label={`New rule ${kind}`}
            placeholder={PLACEHOLDER[kind]}
            maxLength={kind === 'tool' ? 200 : 500}
            disabled={disabled}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <Segmented label="New rule effect" value={effect} items={EFFECTS} disabled={disabled} onChange={setEffect} />
        <Button size="sm" icon="plus" disabled={!canAdd} title={duplicate ? 'That rule is already on the list' : undefined} onClick={add}>
          Add rule
        </Button>
      </div>

      <div className="flex flex-col gap-0.5 text-caption text-tertiary" aria-label="Built-in protections">
        <p className="m-0 flex items-start gap-1.5">
          <Icon name="lock" size={11} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0">Always denied: {PROTECTED_PATH_NOTES.join('; ')}.</span>
        </p>
        <p className="m-0 flex items-start gap-1.5">
          <Icon name="shield" size={11} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            Asks first, unless a path allow covers it:{' '}
            <span className="font-mono">{DEFAULT_ASK_PATHS.join(', ')}</span> (not .env.example).
          </span>
        </p>
      </div>
    </div>
  )
}
