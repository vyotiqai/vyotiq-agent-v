/**
 * The feature pages. Every point is checked against the app's code; the screen
 * named by `shot` is one of the components in components/app.
 */
import type { Sky } from '@/lib/skies'

export type ShotName = 'app' | 'brief' | 'doneWhen' | 'instance' | 'approval' | 'home' | 'rewind' | 'usage'
export type Frame = { w: number; h: number; x: number; y: number; s: number }
export type FeatureShot = { name: ShotName; sky: Sky; label: string; desktop: Frame; phone: Frame }
export type Point = { title: string; body: string }

export type Feature = {
  slug: string
  nav: string
  title: string
  lede: string
  hero: FeatureShot
  points: Point[]
  second?: { title: string; body: string; shot: FeatureShot }
  docs: { label: string; href: string }[]
}

export const FEATURES: Feature[] = [
  {
    slug: 'task-record',
    nav: 'The task record',
    title: 'Every task is a record<br />you can read',
    lede: 'A task starts from a brief and a list of what done means. While it runs you see its plan, each step it takes, and at the end whether every check was met.',
    hero: {
      name: 'app',
      sky: 'hero',
      label: 'A task running: its Done when checks, a written plan, and three instances started in one step.',
      desktop: { w: 1200, h: 700, x: 40, y: 40, s: 0.8 },
      phone: { w: 350, h: 330, x: -120, y: 20, s: 0.5 }
    },
    points: [
      { title: 'Say what done means', body: 'Add up to 20 "Done when" checks to the brief: a command that passes, a file that exists. The agent marks each one met or not met, with the evidence, before it finishes.' },
      { title: 'A plan you can follow', body: 'When it plans the work, the steps tick off as they finish, only the live step stays open, and a step a later plan drops is marked "replaced".' },
      { title: 'Every step, in plain words', body: 'Each row says what happened: Read, Searched, Edited, Created, Ran. Open a row to see the files, the diff or the command output.' },
      { title: 'Steer it while it works', body: 'Type an instruction during a run. Enter queues it for when the run ends; Shift+Enter sends it into the live run now. Esc stops the run.' },
      { title: 'A receipt at the end', body: 'Each run ends with its time, how many checks were met, tokens, output speed, cache hits and cost. A cost marked "~" is estimated from published prices.' },
      { title: 'Ask before you act', body: 'In Ask mode the agent reads and answers with read-only tools. Ctrl+. switches between Agent and Ask, and the agent can switch on its own unless you turn that off.' }
    ],
    second: {
      title: 'Checked, not claimed',
      body: 'A task cannot just say it is done. If a check is still unmarked when it tries to finish, it is reminded once, and the result says how many were left not checked.',
      shot: {
        name: 'doneWhen',
        sky: 'sage',
        label: 'A finished task with all three Done when checks met, the result, and the receipt.',
        desktop: { w: 1200, h: 460, x: 330, y: 44, s: 1 },
        phone: { w: 350, h: 250, x: 14, y: 20, s: 0.595 }
      }
    },
    docs: [
      { label: 'Writing a task', href: '/docs/writing-a-task' },
      { label: 'The task record', href: '/docs/the-task-record' }
    ]
  },
  {
    slug: 'instances',
    nav: 'Instances',
    title: 'Split a big job<br />across instances',
    lede: 'A task can hand parts of its work to instances: helper agents with their own brief, their own branch and their own record, which report back when they finish.',
    hero: {
      name: 'instance',
      sky: 'fog',
      label: "An instance's page: its goal, its own worktree branch, the folder it may write to, and its work so far.",
      desktop: { w: 1200, h: 620, x: 240, y: 40, s: 1 },
      phone: { w: 350, h: 300, x: 14, y: 18, s: 0.5 }
    },
    points: [
      { title: 'Up to 16 at once', body: 'A task runs up to 16 instances in parallel by default; set it anywhere from 1 to 16 in Settings. One more is refused until one finishes.' },
      { title: 'Their own brief', body: 'Each instance gets a goal, the outcome wanted, its sub-tasks and its own Done when checks. It never sees the parent conversation, only its brief.' },
      { title: 'Their own branch', body: 'An instance that writes gets its own git worktree on a vyotiq/instance branch when one can be made, so parallel edits do not collide in your folder.' },
      { title: 'Fenced to folders', body: 'Give an instance a folder scope and it cannot write outside it. A read-only instance runs in Ask mode, with no worktree at all.' },
      { title: 'One level deep', body: 'Instances report back to the task that started them and cannot start instances of their own, so the work stays a tree you can follow.' },
      { title: 'Merged by the parent', body: 'The parent waits for results, reads their summaries and merges their branches. A merge is refused if it would clash with uncommitted changes.' }
    ],
    docs: [{ label: 'Instances', href: '/docs/instances' }]
  },
  {
    slug: 'approvals',
    nav: 'Approvals and review',
    title: 'You decide what it does<br />without asking',
    lede: 'Pick which actions wait for your OK, answer them from one list, and review every change before you keep it. Anything the agent wrote can be rewound.',
    hero: {
      name: 'home',
      sky: 'sand',
      label: 'Home: two tasks waiting on you, an approval and a question, above your workspaces and this week.',
      desktop: { w: 1200, h: 560, x: 280, y: 40, s: 1 },
      phone: { w: 350, h: 300, x: 18, y: 20, s: 0.49 }
    },
    points: [
      { title: 'Three levels', body: '"Edits and commands" lets reading and searching run and asks before anything changes. "Every tool" asks even for reads. You can also turn approvals off.' },
      { title: 'Narrow answers', body: 'Allow once, allow for this task, or always allow one tool or command in this workspace. Commands that chain or redirect are never offered "Always allow".' },
      { title: 'One list for everything waiting', body: 'Home collects approvals and questions from every running task. Allow or deny a command right there; Ctrl+J jumps to the next task that needs you.' },
      { title: 'Approvals do not wait forever', body: 'An approval nobody answers is denied after 15 minutes, so a run does not hang on a prompt you did not see. A question waits for your answer.' },
      { title: 'Keep or undo each file', body: 'Changes lists every file the task touched. Keep it or undo it one file at a time, or all at once.' },
      { title: 'Rewind, then redo', body: 'Rewind a task to before any instruction: the record and the files go back, and files you edited since are left alone. Redo brings it back until something changes.' }
    ],
    second: {
      title: 'Asked where the work is',
      body: 'Inside a task the approval shows exactly what will run, whether it can change files, and when it will be denied if nobody answers.',
      shot: {
        name: 'approval',
        sky: 'fog',
        label: 'An approval card asking to run a database migration, with Allow once, Allow for this task, Always allow and Deny.',
        desktop: { w: 1200, h: 400, x: 380, y: 84, s: 1 },
        phone: { w: 350, h: 220, x: 10, y: 22, s: 0.75 }
      }
    },
    docs: [
      { label: 'Approvals', href: '/docs/approvals' },
      { label: 'Review and rewind', href: '/docs/review-and-rewind' }
    ]
  },
  {
    slug: 'usage',
    nav: 'Usage',
    title: 'See what it did<br />and what it cost',
    lede: 'Usage adds up every task: how many ran and finished, the tokens they used, what they cost, which models did the work and where tools failed.',
    hero: {
      name: 'usage',
      sky: 'slate',
      label: 'Usage for seven days: 23 tasks, 18.4M tokens, $4.12 estimated spend, 87% finished, and tasks per day.',
      desktop: { w: 1200, h: 600, x: 280, y: 40, s: 1 },
      phone: { w: 350, h: 300, x: 18, y: 20, s: 0.49 }
    },
    points: [
      { title: 'Seven or thirty days', body: 'Look at all workspaces or one, over the last 7 or 30 days: tasks, tokens, spend and the share that finished.' },
      { title: 'Per day', body: 'Charts show tasks per day and spend or tokens per day, so a busy or expensive day stands out.' },
      { title: 'Which models', body: 'Model mix shows how the output tokens split between the models you used.' },
      { title: 'Where tools failed', body: 'Tool failures lists the tools that failed most, with the error and how many of their calls failed.' },
      { title: 'Edits nobody checked', body: '"Unchecked" lists tasks that changed files with no passing check after. Worth a test run before you commit.' },
      { title: 'Honest costs', body: 'A provider-reported cost is used when there is one. Otherwise cost is estimated from published prices and marked "est.". Models with no known price show no cost rather than a guess; Ollama is free.' }
    ],
    docs: [{ label: 'Usage and cost', href: '/docs/usage-and-cost' }]
  }
]
