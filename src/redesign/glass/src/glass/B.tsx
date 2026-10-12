import { useState, type ReactNode } from 'react'
import { Button, IconButton, Tooltip, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { BORDER_DIVIDER, NUM, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { BRIEF_CHECKS } from './data'
import { BriefFoot, useField } from './A'
import { AttachMenu, ContextMeter, MicControl, ModeSwitch, ModelPicker, StructureButton, keepFocus } from './controls'
import { INSERTED_WORDS } from './scenes'
import { useGlass } from './store'
import {
  Attachments,
  ErrorAlert,
  FollowUpQueue,
  ReadinessBanner,
  StructureDone,
  StructureWorking,
  TakeInserted,
  TakeListening
} from './strips'

/*
  B · The reference's shape, carrying the same controls.

  Geometry, every number from the pill's height (H = 56) and the reference's
  proportions (its glyphs sit on the caps' centres, its text starts ~0.8 H
  in, its circle is ~0.65 H):
  - The pill is a capsule, radius H/2 = 28.
  - Every control in it is 28px, inset 14px, so its centre sits on the cap's
    centre (14 + 14 = 28) and a capsule's ends run parallel to the pill's.
  - Controls are 8px apart, so neighbouring glyphs sit 36px (0.64 H) apart,
    as the reference's mic and waveform do.
  - The text edge is 50px in, and the rail under the pill starts on that
    edge; its right end stops on the action's right edge.
  - The one thing outside the pill is 36px, 8px off, on the pill's
    centreline: the way out of what the pill is doing — Stop while a run is
    live, Cancel while editing. Nothing sits there otherwise.
  - When the words wrap, the pill grows into a rounded rectangle; the caps
    keep the bottom line, like the reference's end caps keep theirs.

  What shows, and when (the user's picks, 2026-10-09 — "as clean and
  minimal as the image"):
  - An empty pill is the reference: `+` (attach), the placeholder, the mic.
  - Once there is something to send, the right cap swaps the mic for a round
    ↑ (Send, Queue while a run is live, Rerun while editing; Shift+Enter is
    Send now) and Structure (✦) appears beside it. Dictation keeps its
    shortcut, and the mic returns when the field empties.
  - Mode, model · effort and the context reading sit on a rail under the
    pill that shows only while you are working: the composer has focus,
    holds something to send, a run is live, or one of the rail's popovers is
    open. It keeps its space while hidden, so the pill never jumps.
  - The tools are the pill's focal points, at the `default` tone, as the
    reference's white glyphs are. A live take's strip stands in for the
    rail, the mic already being in the pill.
*/

const H = 56
const INSET = 14
const OUT = 36
/** The pill's own shape; it keeps its radius when it grows. */
const PILL = 'gx-glass rounded-[28px]'
/** The text edge: the left cap's control (inset + 28) and the row's 8px gap. */
const TEXT = INSET + 28 + 8
/** A column centred on the left cap's centre (27) whose right side is the text edge. */
const GUTTER = { marginLeft: 2 * (INSET + 14) - TEXT, width: 2 * (TEXT - INSET - 14) }

/** The round control outside the pill, on its centreline. */
function OutsideCircle({ icon, label }: { icon: 'stop' | 'close'; label: string }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        data-gx-emerge
        onMouseDown={keepFocus}
        className="gx-glass inline-grid shrink-0 place-items-center rounded-full text-secondary vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
        style={{ width: OUT, height: OUT, marginBottom: (H - OUT) / 2 }}
      >
        <Icon name={icon} size={icon === 'stop' ? 14 : 16} weight={icon === 'stop' ? 'fill' : 'regular'} />
      </button>
    </Tooltip>
  )
}

/** The line's one action, as a round ↑ in the right cap. Its words live in its name and tooltip. */
function SendCircle({ label, tip, keys, ready }: { label: string; tip: string; keys: string; ready: boolean }) {
  return (
    <Tooltip content={tip}>
      <button
        type="submit"
        aria-label={label}
        aria-keyshortcuts={keys}
        disabled={!ready}
        onMouseDown={keepFocus}
        className="inline-grid size-7 shrink-0 place-items-center rounded-full bg-accent text-accent-fg vy-transition hover:bg-accent-hover focus-visible:vy-focus-ring disabled:vy-disabled-state"
      >
        <Icon name="arrowUp" size={15} weight="bold" />
      </button>
    </Tooltip>
  )
}

/**
 * The bottom line of the pill: left cap · field · the right cap. `swap`: the
 * mic until there is something to send, then Structure and the action. The
 * brief keeps its Start task and mic throughout.
 */
function CapRow({ field, action, swap }: { field?: ReactNode; action: ReactNode; swap: boolean }) {
  const { scene, filled } = useGlass()
  // A live take owns the ways out (its strip, in the rail): the pill keeps only the mic, as the app's row does.
  const takeOpen = scene.take === 'listening'
  const structure = <StructureButton ready={scene.structure !== 'working'} tone="default" />
  return (
    <div className="flex items-end gap-2" style={{ padding: INSET, minHeight: H }}>
      <AttachMenu withScreenshot={scene.surface !== 'brief'} disabled={takeOpen} align="start" tone="default" glyph="plus" />
      <div className="min-w-0 flex-1 self-center py-1 pr-1">{field}</div>
      {takeOpen ? (
        <MicControl tone="default" />
      ) : swap ? (
        filled ? (
          <>
            {structure}
            {action}
          </>
        ) : (
          <MicControl tone="default" />
        )
      ) : (
        <>
          {filled ? structure : null}
          <MicControl tone="default" />
          {action}
        </>
      )}
    </div>
  )
}

/**
 * Under the pill: how the task runs, from the text edge to the action's edge.
 * Shown while you are working; otherwise it folds away (0fr → 1fr) and the
 * pill settles to the bottom, so an idle composer is the pill alone. Folded,
 * it is inert, so its controls leave the tab order too. The fold's inner
 * padding keeps room for the controls' focus rings, which the clip would cut.
 */
function Rail({ context, takeSendLabel, focused }: { context: boolean; takeSendLabel: string | null; focused: boolean }) {
  const { scene, filled, pop } = useGlass()
  const show = focused || filled || scene.running || pop === 'model' || pop === 'context'
  if (scene.take === 'listening') {
    return (
      <div className="mt-1.5 @container">
        <TakeListening sendLabel={takeSendLabel} className="min-w-0" edge="pill" />
      </div>
    )
  }
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
        show ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      )}
      inert={!show}
      data-shown={show || undefined}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-0.5 pt-1.5 @container @max-[480px]:[&_span:has(>kbd)]:hidden"
          style={{ paddingLeft: TEXT, paddingRight: INSET }}
          data-composer-controls
          data-gx-rail
        >
          <div className="flex min-w-0 flex-[1_1_140px] items-center gap-1">
            <ModeSwitch />
            <ModelPicker />
          </div>
          {context ? (
            <div className="ml-auto flex shrink-0 items-center">
              <ContextMeter />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Focus anywhere in the composer — the field, the pill's tools, the rail — and not just the field. */
function useFocusWithin(): [boolean, { onFocus: () => void; onBlur: (e: React.FocusEvent<HTMLElement>) => void }] {
  const [focused, setFocused] = useState(false)
  return [
    focused,
    {
      onFocus: () => setFocused(true),
      onBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }
    }
  ]
}

export function ShapeComposer() {
  const { scene } = useGlass()
  const { field, menus } = useField()
  const [focused, focusProps] = useFocusWithin()
  const ready = !scene.readiness && scene.take !== 'listening' && scene.structure !== 'working'

  if (scene.surface === 'brief') {
    return (
      <div className="mx-auto w-full max-w-[780px] px-5 pt-16" data-gx-clear-shell {...focusProps}>
        {scene.structure === 'working' ? <StructureWorking placement="pill" /> : null}
        <div className={PILL} data-brief data-composer-shell data-gx-field>
          <div style={{ paddingLeft: TEXT, paddingRight: INSET, paddingTop: INSET }}>{field}</div>
          {scene.attachments ? (
            <div className="pt-2" style={{ paddingLeft: TEXT, paddingRight: INSET }}>
              <Attachments />
            </div>
          ) : null}
          {/* Done when: numbers and the + sit on the left cap's centre line, the words on the text edge. */}
          <div className={cn('mt-3 border-t pb-1 pt-1', BORDER_DIVIDER)} style={{ paddingRight: INSET }} data-done-when>
            <div className="flex items-baseline gap-2 pb-0.5 pt-1" style={{ paddingLeft: TEXT }}>
              <span className={SECTION_LABEL}>Done when</span>
              <span className={cn(NUM, 'text-tertiary')}>{BRIEF_CHECKS.length}</span>
            </div>
            <ul className="m-0 list-none p-0" aria-label="Done when">
              {BRIEF_CHECKS.map((text, index) => (
                <li key={text} className="group flex h-7 items-center">
                  <span className={cn(NUM, 'shrink-0 text-center text-tertiary')} style={GUTTER}>
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg" title={text}>
                    {text}
                  </span>
                  <IconButton
                    icon="close"
                    label={`Remove “${text}”`}
                    size="xs"
                    tone="muted"
                    className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  />
                </li>
              ))}
            </ul>
            <label className="group/check flex h-7 cursor-text items-center">
              <span className="flex shrink-0 justify-center" style={GUTTER}>
                <Icon name="plus" size={14} className="text-tertiary group-focus-within/check:text-fg" />
              </span>
              <input
                placeholder="Done when… a command passes, a file exists"
                aria-label="New check"
                className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-tertiary"
              />
            </label>
          </div>
          <div className={cn('border-t', BORDER_DIVIDER)}>
            <CapRow
              swap={false}
              action={
                <Button variant="primary" size="sm" disabled={!ready} title="Start task (Ctrl+Enter)" onMouseDown={keepFocus}>
                  Start task
                </Button>
              }
            />
          </div>
        </div>
        <Rail context={false} takeSendLabel={null} focused={focused} />
        {menus}
        <BriefFoot edge={{ paddingLeft: INSET + 14 - 7, paddingRight: INSET }} />
      </div>
    )
  }

  const inline = scene.surface === 'inline'
  const outside =
    inline ? <OutsideCircle icon="close" label="Cancel edit (Esc)" /> : scene.running ? <OutsideCircle icon="stop" label="Stop the run (Esc)" /> : null
  const action = inline ? (
    <SendCircle label="Rerun" tip="Rerun with the edited instruction (Enter)" keys="Enter" ready={ready} />
  ) : scene.running ? (
    <SendCircle label="Queue" tip="Queue it — it starts when this run ends (Enter) · Send now: Shift+Enter" keys="Enter Shift+Enter" ready={ready} />
  ) : (
    <SendCircle label="Send" tip="Send (Enter)" keys="Enter" ready={ready} />
  )

  return (
    <div className="shrink-0" data-composer-line>
      <div className="mx-auto w-full max-w-[780px] px-4 pb-4" data-composer-column data-gx-clear-shell {...focusProps}>
        {scene.error ? <ErrorAlert edge="pill" className="mb-1" /> : null}
        {scene.followUps ? <FollowUpQueue className="mb-1.5" edge="pill" /> : null}
        {scene.structure === 'working' ? (
          <StructureWorking placement="pill" />
        ) : scene.structure === 'done' ? (
          <StructureDone placement="pill" />
        ) : null}
        {scene.take === 'inserted' ? <TakeInserted words={INSERTED_WORDS.split(' ').length} edge="pill" /> : null}
        <div className="grid items-end gap-x-2" style={{ gridTemplateColumns: outside ? `minmax(0,1fr) ${OUT}px` : 'minmax(0,1fr)' }}>
          <form className={PILL} data-composer-shell data-gx-field onSubmit={(e) => e.preventDefault()}>
            {scene.readiness ? <ReadinessBanner primary edge="pill" /> : null}
            {scene.attachments ? (
              <div className="pt-3" style={{ paddingLeft: TEXT, paddingRight: INSET }}>
                <Attachments />
              </div>
            ) : null}
            <CapRow field={field} action={action} swap />
          </form>
          {outside}
          <div className="min-w-0">
            <Rail context takeSendLabel={inline ? 'Rerun' : scene.running ? 'Queue' : 'Send'} focused={focused} />
          </div>
        </div>
      </div>
      {menus}
    </div>
  )
}
