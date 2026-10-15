import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Button, IconButton, Keys, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { BORDER_DIVIDER, NUM, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { resolveLinePlaceholder } from '../../../../renderer/src/features/chat/components/composer/composerPlaceholder'
import { useActions } from './actions'
import { AttachMenu, ContextMeter, LineAction, MicControl, ModeSwitch, ModelPicker, StopButton, StructureButton, keepFocus } from './controls'
import { Field } from './field'
import { MentionMenu, SlashMenu } from './menus'
import { INSERTED_WORDS, LIVE_WORDS } from './scenes'
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
  A · Your anatomy. Composer.tsx's three surfaces with nothing moved: the
  field, what is attached, then one control row — mode, model · effort,
  context, Structure, attach, mic, Stop while live, the one action. Only the
  material changes: the box is glass, every control a capsule.

  The box's radius is the control row's: a 28px capsule sits ~9px in from
  the box's corner, so 14 + 9 ≈ the box's 22 and the two curves run parallel.
*/

const BOX = 'gx-glass rounded-[var(--vy-radius-xl)]'
/** COMPOSER_BOX_BLEED: the line's and Edit and rerun's box reaches into the gutter. */
const BLEED = '-mx-2'

/** The control row, the same on every surface; a live take's strip stands in for it. */
function Controls({ action, context, takeSendLabel }: { action: ReactNode; context: boolean; takeSendLabel: string | null }) {
  const { scene, filled } = useGlass()
  if (scene.take === 'listening') {
    return (
      <div className="flex h-10 min-w-0 items-center gap-1 @max-[480px]:[&_span:has(>kbd)]:hidden" data-composer-controls>
        <TakeListening sendLabel={takeSendLabel} className="min-w-0 flex-1" />
        <MicControl />
      </div>
    )
  }
  return (
    <>
      {scene.take === 'inserted' ? <TakeInserted words={INSERTED_WORDS.split(' ').length} /> : null}
      <div
        className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 @max-[480px]:[&_span:has(>kbd)]:hidden"
        data-composer-controls
      >
        <div className="flex min-w-0 flex-[1_1_140px] items-center gap-1">
          <ModeSwitch />
          <ModelPicker />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {context ? <ContextMeter /> : null}
          <StructureButton ready={filled && scene.structure !== 'working'} />
          <AttachMenu withScreenshot={scene.surface !== 'brief'} />
          <MicControl />
          {scene.surface === 'line' && scene.running ? <StopButton /> : null}
          {action}
        </div>
      </div>
    </>
  )
}

/** The New check input: Enter adds what it holds to Done when (and stays out of the composer's keys). */
export function onCheckKey(add: (text: string) => boolean) {
  return (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    e.stopPropagation()
    if (add(e.currentTarget.value)) e.currentTarget.value = ''
  }
}

export function useField() {
  const { scene, mode, rev, focusOnDraw, caretOnDraw, fieldRef } = useGlass()
  const actions = useActions()
  const anchor = useRef<HTMLDivElement>(null)
  const setInput = useCallback(
    (el: HTMLDivElement | null) => {
      fieldRef.current = el
    },
    [fieldRef]
  )
  const placeholder =
    scene.surface === 'brief'
      ? mode === 'ask'
        ? 'Ask about this workspace — the agent reads and answers, and changes nothing'
        : 'Describe the task — the agent plans it, does it, and shows you the result'
      : scene.surface === 'inline'
        ? 'Edit the instruction…'
        : resolveLinePlaceholder({ hasWorkspace: true, running: scene.running, agentMode: mode, outcome: scene.error ? 'failed' : null })
  const field = (
    <Field
      // Each redraw (a pick, Send, a take, Structure) is a new field holding the scene's words.
      key={rev}
      anchorRef={anchor}
      inputRef={setInput}
      focusOnMount={focusOnDraw}
      caretAfter={caretOnDraw}
      onEdit={actions.onEdit}
      segments={scene.segments}
      placeholder={placeholder}
      size={scene.surface === 'brief' ? 'brief' : 'sm'}
      ariaLabel={scene.surface === 'brief' ? 'Brief' : 'Instruction'}
      live={scene.take === 'listening' ? LIVE_WORDS : null}
      inserted={scene.take === 'inserted' ? INSERTED_WORDS : null}
      readOnly={scene.structure === 'working'}
    />
  )
  const menus = (
    <>
      <SlashMenu anchor={anchor} onPick={actions.pickSlash} />
      <MentionMenu anchor={anchor} onPick={actions.pickMention} />
    </>
  )
  return { field, menus }
}

export function AnatomyComposer() {
  const { scene, filled, attached, queue, checks } = useGlass()
  const actions = useActions()
  const { field, menus } = useField()
  const { ready, canSend } = actions
  const attachments = attached.image || attached.file

  if (scene.surface === 'brief') {
    return (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- delegates the field's and controls' own keys
      <div className="mx-auto w-full max-w-[780px] px-5 pt-16" onKeyDown={actions.onKeyDown}>
        {scene.structure === 'working' ? <StructureWorking placement="brief" /> : null}
        <div className={BOX} data-brief data-composer-shell data-gx-field>
          <div className="px-4 pt-3.5">{field}</div>
          {attachments ? (
            <div className="px-4 pt-2">
              <Attachments />
            </div>
          ) : null}
          <div className={cn('mt-3 border-t py-1 pl-4 pr-2', BORDER_DIVIDER)} data-done-when>
            <div className="flex items-baseline gap-2 pb-0.5 pt-1">
              <span className={SECTION_LABEL}>Done when</span>
              <span className={cn(NUM, 'text-tertiary')}>{checks.length}</span>
            </div>
            <ul className="m-0 list-none p-0" aria-label="Done when">
              {checks.map((text, index) => (
                <li key={text} className="group flex h-7 items-center gap-2.5">
                  <span className={cn(NUM, 'w-4 shrink-0 text-right text-tertiary')}>{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg" title={text}>
                    {text}
                  </span>
                  <IconButton
                    icon="close"
                    label={`Remove “${text}”`}
                    size="xs"
                    tone="muted"
                    className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                    onClick={() => actions.removeCheck(text)}
                  />
                </li>
              ))}
            </ul>
            <label className="group/check flex h-7 cursor-text items-center gap-2.5">
              <span className="flex w-4 shrink-0 justify-center">
                <Icon name="plus" size={14} className="text-tertiary group-focus-within/check:text-fg" />
              </span>
              <input
                placeholder="Done when… a command passes, a file exists"
                aria-label="New check"
                onKeyDown={onCheckKey(actions.addCheck)}
                className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-tertiary"
              />
            </label>
          </div>
          <div className={cn('border-t pb-1 pl-4 pr-3 @container', BORDER_DIVIDER)}>
            <Controls
              context={false}
              takeSendLabel={null}
              action={
                <Button variant="primary" size="sm" disabled={!canSend} title="Start task (Ctrl+Enter)" onMouseDown={keepFocus} onClick={actions.startTask}>
                  Start task
                </Button>
              }
            />
          </div>
        </div>
        {menus}
        <BriefFoot />
      </div>
    )
  }

  if (scene.surface === 'inline') {
    return (
      <div className="mx-auto w-full max-w-[780px] px-4 pb-4">
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- delegates the field's and controls' own keys */}
        <div className="flex w-full flex-col gap-2" data-composer-inline onKeyDown={actions.onKeyDown}>
          <form
            className={cn(BOX, BLEED)}
            data-composer-shell
            data-gx-field
            onSubmit={(e) => {
              e.preventDefault()
              actions.rerun()
            }}
          >
            <div className="px-3 pt-2.5">{field}</div>
            <div className="pb-1 pl-3 pr-2 @container">
              <Controls
                context
                takeSendLabel="Rerun"
                action={
                  <>
                    <Button size="sm" variant="ghost" kbd={['Esc']} aria-label="Cancel edit" onMouseDown={keepFocus} onClick={actions.cancelEdit}>
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      variant="secondary"
                      kbd={['↵']}
                      aria-label="Rerun"
                      title="Rerun with the edited instruction"
                      disabled={!canSend}
                      onMouseDown={keepFocus}
                    >
                      Rerun
                    </Button>
                  </>
                }
              />
            </div>
          </form>
          {menus}
        </div>
      </div>
    )
  }

  return (
    <div className="shrink-0" data-composer-line>
      <div className="pr-2" data-composer-gutter>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- delegates the field's and controls' own keys */}
        <div className="mx-auto w-full max-w-[780px] px-4 pb-4" data-composer-column onKeyDown={actions.onKeyDown}>
          {scene.error ? (
            <div className="flex flex-col gap-2 pb-2">
              <ErrorAlert />
            </div>
          ) : null}
          {queue.length ? <FollowUpQueue className="mb-1.5" /> : null}
          {scene.structure === 'working' ? <StructureWorking /> : scene.structure === 'done' ? <StructureDone /> : null}
          <form
            className={cn(BOX, BLEED)}
            data-composer-shell
            data-gx-field
            onSubmit={(e) => {
              e.preventDefault()
              actions.submit()
            }}
          >
            {scene.readiness ? (
              <div className="px-3 pt-3">
                <ReadinessBanner primary />
              </div>
            ) : null}
            <div className="px-3 pt-2.5">{field}</div>
            {attachments ? (
              <div className="px-3 pt-2">
                <Attachments />
              </div>
            ) : null}
            <div className="pb-1 pl-3 pr-2 @container">
              <Controls
                context
                takeSendLabel={scene.running ? 'Queue' : 'Send'}
                action={<LineAction running={scene.running} hasText={filled} ready={ready} />}
              />
            </div>
          </form>
        </div>
      </div>
      {menus}
    </div>
  )
}

/** The quiet row under the New task box: scope left, its manners and the way aside right. */
export function BriefFoot({ edge }: { edge?: React.CSSProperties }) {
  return (
    <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" style={edge}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-added-folders>
        <button
          type="button"
          className="flex h-7 items-center gap-2.5 rounded-sm text-xs text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
          title="Also let the task read and edit another folder, by absolute path"
        >
          <Icon name="folderPlus" size={14} className="shrink-0" />
          Add folder…
        </button>
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <span className="flex items-center gap-1.5 text-xs text-tertiary">
          <Keys keys={['Ctrl', '↵']} />
          <span>start</span>
        </span>
        <Button variant="ghost" size="xs">
          Save as draft
        </Button>
        <Button variant="ghost" size="xs" icon="repeat" title="Run this brief on a schedule, a new task each time">
          Schedule…
        </Button>
        <p className="m-0 ml-auto flex min-w-0 items-center gap-2 text-xs text-muted" data-approval-note>
          <span className="min-w-0 truncate">Asks before edits and commands · MCP tools ask first</span>
          <button
            type="button"
            className="shrink-0 rounded-sm font-medium text-secondary underline-offset-2 vy-transition hover:text-fg hover:underline focus-visible:vy-focus-ring"
          >
            Change
          </button>
        </p>
      </div>
    </div>
  )
}
