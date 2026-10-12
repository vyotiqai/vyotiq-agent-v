import { Conversation } from './a/Conversation'
import { ConversationPlus } from './aplus/Conversation'
import { Outcome } from './b/Outcome'
import { Split } from './c/Split'
import { TitleBar } from './parts'
import { ThreadsProvider } from './store'

export const DIRECTIONS = [
  {
    id: 'aplus',
    label: 'A+ · Conversation, refined',
    note: 'A, refined: answers stream in word by word through a new Markdown renderer; the work is one line per reply that opens on the steps in order; files and checks arrive after the answer. Queue or Send now while it works, edit and rerun, search, Alt ↑/↓.'
  },
  {
    id: 'a',
    label: 'A · Conversation',
    note: 'Your message, then its reply. The work folds into one line above each reply: open while it runs, folded once it settles, so the answer sits right under what you asked.'
  },
  {
    id: 'b',
    label: 'B · Outcome first',
    note: 'Your ask is the heading. One status line, then the answer, then what changed and the checks side by side. How it got there is a fold, and earlier turns shrink to one line each.'
  },
  {
    id: 'c',
    label: 'C · Conversation + work',
    note: 'The middle is only the conversation. Each reply has a chip that points the right pane at its work: steps, diffs and commands. Reading and auditing happen in two places.'
  }
] as const

export type Direction = (typeof DIRECTIONS)[number]['id']

export const SCENES = [
  { id: 'rate', label: 'Running' },
  { id: 'flaky', label: 'Needs you' },
  { id: 'dark', label: 'Review · 2 turns' },
  { id: 'build', label: 'Ask answer' },
  { id: 'session', label: 'Rich answer' },
  { id: 'oauth', label: 'Failed' },
  { id: 'new', label: 'New thread' }
] as const

export type SceneId = (typeof SCENES)[number]['id']

export function App({ direction, scene }: { direction: Direction; scene: SceneId }) {
  const Body = direction === 'aplus' ? ConversationPlus : direction === 'a' ? Conversation : direction === 'b' ? Outcome : Split
  return (
    <ThreadsProvider initial={scene === 'new' ? null : scene}>
      <div className="flex h-full flex-col bg-bg text-fg">
        <TitleBar>Agent V</TitleBar>
        <Body />
      </div>
    </ThreadsProvider>
  )
}
