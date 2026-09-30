import { useRef, type JSX, type KeyboardEvent } from 'react'
import { CheckMark, Input, RadioMark, Textarea, cn } from '@renderer/lib/ui'
import { CONTROL_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import type { UiAgentQuestionItem } from '@shared/transcript'
import { AGENT_QUESTION_MAX_ANSWER_CHARS } from '@shared/utils/agentQuestionForm'

/**
 * The focus ring drawn inside the option: an outline would sit on the selected
 * fill of its neighbour and clip under the gate's overflow-hidden. Same colour
 * as `vy-focus-ring`.
 */
const OPTION_FOCUS =
  'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus'
const OPTION_BASE = cn(
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm vy-transition',
  'disabled:vy-disabled-state',
  OPTION_FOCUS
)
/** Hover stays lighter than the selected fill so hover never reads as answered. */
const OPTION_IDLE = cn('text-secondary hover:text-fg', CONTROL_HOVER)
const OPTION_ACTIVE = SELECTED

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
  /** Ctrl/Cmd+Enter in a text answer, where plain Enter is a newline. */
  onSubmitShortcut?: () => void
}

function OptionMark({
  kind,
  active
}: {
  kind: 'radio' | 'check'
  active: boolean
}): JSX.Element {
  // The option row is already the radio or checkbox, so it draws only the mark.
  return kind === 'check' ? <CheckMark on={active} /> : <RadioMark on={active} />
}

function CustomOther({
  value,
  disabled,
  onChange,
  onFocus
}: {
  value: string
  disabled?: boolean
  onChange: (text: string) => void
  onFocus?: () => void
}): JSX.Element {
  return (
    <Input
      type="text"
      size="md"
      className="mt-1"
      placeholder="Other…"
      aria-label="Other answer"
      maxLength={AGENT_QUESTION_MAX_ANSWER_CHARS}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
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
  // Other text naming a ticked option is that option, not a second answer.
  return custom && !selected.includes(custom) ? [...selected, custom] : selected
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
  // The Other text is the answer only while it is what's selected: picking an
  // option keeps the typed text (focus the field again to go back to it).
  const custom = customText.trim()
  const customActive =
    allowCustom && custom.length > 0 && selected === custom && !options.includes(custom)
  const selectedIndex = customActive ? -1 : options.indexOf(selected)
  const { tabIndexFor, setOptionRef, onGroupKeyDown } = useRovingOptions(
    options.length,
    selectedIndex >= 0 ? selectedIndex : 0,
    selectOnArrow === false ? undefined : (index) => onChange([options[index]!], customText)
  )

  return (
    <div className="flex flex-col">
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
              onClick={() => onChange([option], customText)}
            >
              <OptionMark kind="radio" active={active} />
              <span className="min-w-0 break-words">{option}</span>
            </button>
          )
        })}
      </div>
      {/* Outside the radiogroup: a text field is not one of its radios. */}
      {allowCustom ? (
        <CustomOther
          value={customText}
          disabled={disabled}
          onChange={(text) => {
            const trimmed = text.trim()
            onChange(trimmed ? [trimmed] : [], text)
          }}
          onFocus={() => {
            if (custom && selected !== custom) onChange([custom], customText)
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
              'disabled:vy-disabled-state',
              OPTION_FOCUS,
              active ? cn('border-border-strong', SELECTED) : cn('border-border text-secondary', CONTROL_HOVER)
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
  onChange,
  onSubmitShortcut
}: QuestionFieldProps): JSX.Element {
  return (
    <Textarea
      id={`${promptId}-input`}
      placeholder="Your answer…"
      aria-labelledby={promptId}
      maxLength={AGENT_QUESTION_MAX_ANSWER_CHARS}
      disabled={disabled}
      value={values[0] ?? ''}
      onChange={(e) => onChange(e.target.value ? [e.target.value] : [], '')}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !onSubmitShortcut) return
        e.preventDefault()
        onSubmitShortcut()
      }}
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
