import { useRef, type JSX, type KeyboardEvent } from 'react'
import { cn } from '@renderer/lib/ui'
import type { UiAgentQuestionItem } from '@shared/transcript'

/** Inset focus — outer outline clashes with selection and clips under overflow-hidden. */
const OPTION_FOCUS =
  'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong'
const OPTION_BASE = cn(
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm vy-transition',
  'disabled:opacity-[var(--vy-disabled-opacity)]',
  OPTION_FOCUS
)
/** Hover stays lighter than selected fill so hover ≠ answered. */
const OPTION_IDLE = 'text-secondary hover:bg-surface/50 hover:text-fg'
const OPTION_ACTIVE = 'bg-surface-2 text-fg ring-1 ring-inset ring-border/70'

export type QuestionFieldProps = {
  item: UiAgentQuestionItem
  values: string[]
  customText: string
  disabled?: boolean
  promptId: string
  /** Radio convention: arrows move focus AND selection. Off for quick-submit
   *  forms where an accidental arrow would submit the answer. */
  selectOnArrow?: boolean
  onChange: (values: string[], customText: string) => void
}

function OptionMark({
  kind,
  active
}: {
  kind: 'radio' | 'check'
  active: boolean
}): JSX.Element {
  return (
    <span
      className={cn(
        'flex h-3.5 w-3.5 shrink-0 items-center justify-center border border-border',
        kind === 'radio' ? 'rounded-full' : 'rounded-sm',
        active && 'border-fg bg-fg'
      )}
      aria-hidden
    >
      {active ? (
        <span
          className={cn(
            'bg-bg',
            kind === 'radio' ? 'h-1.5 w-1.5 rounded-full' : 'h-1.5 w-1.5'
          )}
        />
      ) : null}
    </span>
  )
}

function CustomOther({
  value,
  disabled,
  onChange
}: {
  value: string
  disabled?: boolean
  onChange: (text: string) => void
}): JSX.Element {
  return (
    <input
      type="text"
      className={cn(
        'mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg',
        OPTION_FOCUS
      )}
      placeholder="Other…"
      aria-label="Other answer"
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function optionSelections(
  options: string[],
  values: string[],
  customText: string
): string[] {
  const custom = customText.trim()
  const selected = options.filter((o) => values.includes(o))
  return custom ? [...selected, custom] : selected
}

/**
 * WAI-ARIA roving tabindex for option groups: one stop in the Tab order,
 * arrows move focus (and, for radios, selection follows focus).
 */
function useRovingOptions(
  count: number,
  tabbableIndex: number,
  onArrowSelect?: (index: number) => void
): {
  tabIndexFor: (index: number) => number
  setOptionRef: (index: number) => (el: HTMLButtonElement | null) => void
  onGroupKeyDown: (e: KeyboardEvent) => void
} {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const tabIndexFor = (index: number): number => (index === tabbableIndex ? 0 : -1)
  const setOptionRef =
    (index: number) =>
    (el: HTMLButtonElement | null): void => {
      refs.current[index] = el
    }
  const onGroupKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft') {
      return
    }
    const active = document.activeElement
    const current = refs.current.findIndex((el) => el === active)
    if (current < 0) return
    e.preventDefault()
    const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
    const next = (current + delta + count) % count
    const target = refs.current[next]
    if (!target || target.disabled) return
    target.focus()
    onArrowSelect?.(next)
  }
  return { tabIndexFor, setOptionRef, onGroupKeyDown }
}

export function SingleChoiceField({
  item,
  values,
  customText,
  disabled,
  promptId,
  selectOnArrow,
  onChange
}: QuestionFieldProps): JSX.Element {
  const selected = values[0] ?? ''
  const options = item.options ?? []
  const allowCustom = item.allowCustom === true
  const customActive = allowCustom && customText.trim().length > 0
  const selectedIndex = customActive ? -1 : options.indexOf(selected)
  const { tabIndexFor, setOptionRef, onGroupKeyDown } = useRovingOptions(
    options.length,
    selectedIndex >= 0 ? selectedIndex : 0,
    selectOnArrow === false ? undefined : (index) => onChange([options[index]!], '')
  )

  return (
    <div
      role="radiogroup"
      aria-labelledby={promptId}
      tabIndex={-1}
      className="flex flex-col gap-0.5"
      onKeyDown={onGroupKeyDown}
    >
      {options.map((option, index) => {
        const active = !customActive && selected === option
        return (
          <button
            key={option}
            ref={setOptionRef(index)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={tabIndexFor(index)}
            disabled={disabled}
            className={cn(OPTION_BASE, active ? OPTION_ACTIVE : OPTION_IDLE)}
            onClick={() => onChange([option], '')}
          >
            <OptionMark kind="radio" active={active} />
            <span className="min-w-0 break-words">{option}</span>
          </button>
        )
      })}
      {allowCustom ? (
        <CustomOther
          value={customText}
          disabled={disabled}
          onChange={(text) => {
            const trimmed = text.trim()
            onChange(trimmed ? [trimmed] : [], text)
          }}
        />
      ) : null}
    </div>
  )
}

export function MultiChoiceField({
  item,
  values,
  customText,
  disabled,
  promptId,
  onChange
}: QuestionFieldProps): JSX.Element {
  const options = item.options ?? []
  const allowCustom = item.allowCustom === true
  const selected = new Set(options.filter((o) => values.includes(o)))
  const firstSelected = options.findIndex((o) => selected.has(o))
  const { tabIndexFor, setOptionRef, onGroupKeyDown } = useRovingOptions(
    options.length,
    firstSelected >= 0 ? firstSelected : 0
  )

  return (
    <div
      role="group"
      aria-labelledby={promptId}
      className="flex flex-col gap-0.5"
    >
      {options.map((option, index) => {
        const active = selected.has(option)
        return (
          <button
            key={option}
            ref={setOptionRef(index)}
            type="button"
            role="checkbox"
            aria-checked={active}
            tabIndex={tabIndexFor(index)}
            disabled={disabled}
            className={cn(OPTION_BASE, active ? OPTION_ACTIVE : OPTION_IDLE)}
            onClick={() => {
              const next = new Set(selected)
              if (next.has(option)) next.delete(option)
              else next.add(option)
              onChange(
                optionSelections(options, [...next], customText),
                customText
              )
            }}
            onKeyDown={onGroupKeyDown}
          >
            <OptionMark kind="check" active={active} />
            <span className="min-w-0 break-words">{option}</span>
          </button>
        )
      })}
      {allowCustom ? (
        <CustomOther
          value={customText}
          disabled={disabled}
          onChange={(text) => {
            onChange(optionSelections(options, values, text), text)
          }}
        />
      ) : null}
    </div>
  )
}

export function BooleanField({
  values,
  disabled,
  promptId,
  selectOnArrow,
  onChange
}: QuestionFieldProps): JSX.Element {
  const selected = values[0] ?? ''
  const options = ['Yes', 'No'] as const
  const selectedIndex = options.indexOf(selected as 'Yes' | 'No')
  const { tabIndexFor, setOptionRef, onGroupKeyDown } = useRovingOptions(
    options.length,
    selectedIndex >= 0 ? selectedIndex : 0,
    selectOnArrow === false ? undefined : (index) => onChange([options[index]!], '')
  )
  return (
    <div
      role="radiogroup"
      aria-labelledby={promptId}
      tabIndex={-1}
      className="flex gap-1.5"
      onKeyDown={onGroupKeyDown}
    >
      {options.map((option, index) => {
        const active = selected === option
        return (
          <button
            key={option}
            ref={setOptionRef(index)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={tabIndexFor(index)}
            disabled={disabled}
            className={cn(
              'min-w-[4.5rem] rounded-md border px-3 py-1.5 text-sm vy-transition',
              'disabled:opacity-[var(--vy-disabled-opacity)]',
              OPTION_FOCUS,
              active
                ? 'border-border-strong bg-surface-2 text-fg'
                : 'border-border text-secondary hover:bg-surface/50'
            )}
            onClick={() => onChange([option], '')}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

export function TextField({
  values,
  disabled,
  promptId,
  onChange
}: QuestionFieldProps): JSX.Element {
  return (
    <textarea
      id={`${promptId}-input`}
      className={cn(
        'min-h-[64px] w-full resize-y rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg',
        OPTION_FOCUS
      )}
      placeholder="Your answer…"
      aria-labelledby={promptId}
      disabled={disabled}
      value={values[0] ?? ''}
      onChange={(e) => onChange(e.target.value ? [e.target.value] : [], '')}
    />
  )
}

export function QuestionField(props: QuestionFieldProps): JSX.Element {
  switch (props.item.type) {
    case 'single':
      return <SingleChoiceField {...props} />
    case 'multi':
      return <MultiChoiceField {...props} />
    case 'boolean':
      return <BooleanField {...props} />
    case 'text':
      return <TextField {...props} />
    default: {
      const _exhaustive: never = props.item.type
      throw new Error(`Unhandled question field type: ${String(_exhaustive)}`)
    }
  }
}
