import type { TaskState } from '@renderer/lib/ui'

/*
  Mock content. Titles, agent ids and numbers are lifted from the real app's
  own runs (the composer-menus task, 9657c02d…) so the Rail is judged against
  work that actually happened, not lorem.
*/

export type DiffLine = { n: number | null; sign: '+' | '−' | ' '; text: string }

export type WorkItem =
  | { kind: 'note'; text: string }
  | { kind: 'reads'; verb: string; files: string[] }
  | { kind: 'terminal'; command: string; lines: string[]; exit: number | null }
  | { kind: 'diff'; file: string; add: number; del: number; lines: DiffLine[] }
  | { kind: 'agent'; id: string; title: string; state: TaskState; time: string }

export type Step = { title: string; state: TaskState; time: string; work: WorkItem[] }

export type Check = { text: string; met: boolean | null; evidence?: string }

export type ChangedFile = { path: string; add: number; del: number; status: 'M' | 'A' | 'D' }

export type Gate = {
  title: string
  why: string
  command: string
}

export type Task = {
  id: string
  title: string
  state: TaskState
  group: 'needs' | 'running' | 'review' | 'done'
  meta: string
  brief: string
  checks: Check[]
  steps: Step[]
  files: ChangedFile[]
  gate?: Gate
  result?: { summary: string; receipt: string }
  /** 0..1 per step for the run strip; null = not started. */
  elapsed: string
}

export const FILE_TREE = [
  'src/renderer/src/features/chat/components/composer/MentionMenu.tsx',
  'src/renderer/src/features/chat/components/composer/SlashCommandMenu.tsx',
  'src/renderer/src/features/chat/components/composer/useComposerMentions.ts',
  'src/renderer/src/features/chat/components/composer/Composer.tsx',
  'src/main/workspace/fileListCache.ts',
  'src/main/ipc/register.ts',
  'tests/renderer/composer/composerMenuViewport.test.tsx',
  'tests/renderer/composer/mentionSelection.test.tsx'
] as const

export const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
export const dir = (p: string): string => p.slice(0, p.lastIndexOf('/'))

const COMPOSER: Task = {
  id: 'composer',
  title: 'Redesign the / and @ composer menus',
  state: 'running',
  group: 'running',
  meta: '4/5',
  elapsed: '1h 42m',
  brief:
    'Redesign both the / slash command menu and the @ mention menu. Files and folders can’t be picked from @ at all. Make both clean, organized and responsive at any window size.',
  checks: [
    { text: 'Picking a folder from @ inserts a chip that resolves to its files', met: true },
    { text: 'Both menus stay inside the window at 800 and 1600px', met: true },
    { text: 'Both menus use only menu primitives and theme tokens', met: true },
    { text: 'Tests in tests/renderer/composer pass', met: true },
    { text: 'slashCommandMenu.test.tsx still passes unchanged', met: true },
    { text: 'Lint reports no new errors', met: null },
    { text: 'Typecheck reports no new errors', met: null }
  ],
  steps: [
    {
      title: 'Find why files and folders can’t be picked from @',
      state: 'done',
      time: '33m',
      work: [
        { kind: 'agent', id: '9657c02d', title: 'Diagnose, read-only', state: 'done', time: '33m 33s' },
        { kind: 'reads', verb: 'Read', files: [FILE_TREE[0], FILE_TREE[2], FILE_TREE[5]] },
        {
          kind: 'note',
          text: 'The pick handler works. The list comes back empty and nothing says so: folders are never sent over IPC, and a failed walk is swallowed.'
        },
        {
          kind: 'terminal',
          command: 'pnpm vitest run tests/renderer/composer/mentionSelection.test.tsx',
          lines: ['× picks a folder as a folder chip', '  expected 1 chip, received 0', '', 'Tests  1 failed | 2 passed (3)'],
          exit: 1
        }
      ]
    },
    {
      title: 'Redesign the / slash command menu',
      state: 'done',
      time: '29m',
      work: [
        { kind: 'agent', id: '39fa18c2', title: 'Slash menu', state: 'done', time: '29m 42s' },
        {
          kind: 'diff',
          file: FILE_TREE[1],
          add: 24,
          del: 17,
          lines: [
            { n: 18, sign: ' ', text: 'return (' },
            { n: 19, sign: '−', text: '  <div className={cn(MENU_SURFACE, open && "block")}>' },
            { n: 19, sign: '+', text: '  <div className={MENU_SURFACE}>' },
            { n: 20, sign: '+', text: '    <MenuGroup label="Skills" rows={skills} />' },
            { n: 21, sign: '+', text: '    <MenuGroup label="Commands" rows={commands} />' },
            { n: 22, sign: ' ', text: '    <MenuFooter keys={["↑", "↓", "↵"]} />' }
          ]
        }
      ]
    },
    {
      title: 'Redesign the @ menu and send folders over IPC',
      state: 'done',
      time: '52m',
      work: [
        { kind: 'agent', id: '9b88ccae', title: 'First try, failed the viewport check', state: 'failed', time: '34m' },
        { kind: 'agent', id: 'ffc9907c', title: 'Second try, from the first one’s work', state: 'done', time: '17m' },
        {
          kind: 'diff',
          file: FILE_TREE[0],
          add: 38,
          del: 21,
          lines: [
            { n: 42, sign: ' ', text: '  const rows = view.items.map((item, i) => (' },
            { n: 43, sign: '−', text: '    <li className={cn(MENU_ROW, i === active && SELECTED)}>' },
            { n: 43, sign: '+', text: '    <li className={i === active ? MENU_ROW_ACTIVE : MENU_ROW_IDLE}' },
            { n: 44, sign: '+', text: '        onPointerDown={() => onPick(item)}>' },
            { n: 45, sign: ' ', text: '      <MentionIcon kind={item.kind} />' },
            { n: 46, sign: '−', text: '      {item.kind === "file" && <span>{item.path}</span>}' },
            { n: 46, sign: '+', text: '      <span className="truncate">{item.label}</span>' },
            { n: 47, sign: '+', text: '      {item.kind === "folder" && <Count n={item.count} />}' }
          ]
        },
        { kind: 'reads', verb: 'Edited', files: [FILE_TREE[2], FILE_TREE[4]] }
      ]
    },
    {
      title: 'Verify: tests, viewport, lint, typecheck',
      state: 'running',
      time: '7m',
      work: [
        { kind: 'agent', id: '77175da5', title: 'Verify', state: 'running', time: '7m' },
        {
          kind: 'terminal',
          command: 'pnpm vitest run tests/renderer/composer',
          lines: ['Test Files  35 passed (35)', '     Tests  294 passed (294)', '  Duration  18.2s'],
          exit: 0
        },
        {
          kind: 'terminal',
          command: 'npx eslint src/renderer/src/features/chat/components/composer',
          lines: ['checking 9 files…'],
          exit: null
        }
      ]
    },
    { title: 'Report back with the proof', state: 'queued', time: '', work: [] }
  ],
  files: [
    { path: FILE_TREE[0], add: 38, del: 21, status: 'M' },
    { path: FILE_TREE[1], add: 24, del: 17, status: 'M' },
    { path: FILE_TREE[2], add: 12, del: 4, status: 'M' },
    { path: FILE_TREE[4], add: 9, del: 2, status: 'M' },
    { path: FILE_TREE[6], add: 196, del: 0, status: 'A' }
  ]
}

const KEYS: Task = {
  id: 'keys',
  title: 'Rotate the staging API keys',
  state: 'needs',
  group: 'needs',
  meta: '2m',
  elapsed: '11m',
  brief: 'Rotate the staging API keys for the uploader and update the GitHub secret. Keep production untouched.',
  checks: [
    { text: 'A new staging key exists and the old one is revoked', met: true },
    { text: 'STAGING_API_KEY is updated in GitHub secrets', met: null },
    { text: 'The staging smoke test passes with the new key', met: null }
  ],
  steps: [
    {
      title: 'Create a new staging key and revoke the old one',
      state: 'done',
      time: '6m',
      work: [
        {
          kind: 'terminal',
          command: 'uploader-cli keys rotate --env staging',
          lines: ['created  key_stg_7f2…a91', 'revoked  key_stg_c03…e18'],
          exit: 0
        }
      ]
    },
    {
      title: 'Update the GitHub secret',
      state: 'needs',
      time: '2m',
      work: [{ kind: 'note', text: 'This writes to the repository’s secrets, which I can’t undo on my own.' }]
    },
    { title: 'Run the staging smoke test', state: 'queued', time: '', work: [] }
  ],
  gate: {
    title: 'Allow a write to GitHub secrets?',
    why: 'It replaces STAGING_API_KEY for every workflow in vyotiqai/uploader. The old value is not kept.',
    command: 'gh secret set STAGING_API_KEY --repo vyotiqai/uploader --body "$NEW_KEY"'
  },
  files: []
}

const DIFFS: Task = {
  id: 'diffs',
  title: 'Show real line numbers in diffs',
  state: 'review',
  group: 'review',
  meta: '+88 −12',
  elapsed: '42m',
  brief:
    'The diffs don’t show the real line numbers where the change happened. Show the file’s own numbers on both sides, including in split view.',
  checks: [
    { text: 'Unified diffs show the old and new line numbers', met: true, evidence: 'diffGutter.test.tsx · 6 passed' },
    { text: 'Split view numbers each side from its own file', met: true, evidence: 'splitDiff.test.tsx · 4 passed' },
    { text: 'A hunk that starts at line 1,200 shows 1200, not 1', met: true, evidence: 'Checked against git diff -U0 on 3 files' },
    { text: 'Typecheck and lint report no new errors', met: true, evidence: 'tsc · eslint · exit 0' }
  ],
  steps: [
    {
      title: 'Read how hunks are parsed today',
      state: 'done',
      time: '8m',
      work: [
        { kind: 'reads', verb: 'Read', files: ['src/renderer/src/features/inspector/diff/parseHunks.ts', 'src/renderer/src/features/inspector/diff/DiffView.tsx'] },
        { kind: 'note', text: 'The parser drops the @@ header, so every hunk restarts at 1.' }
      ]
    },
    {
      title: 'Keep the hunk header and number both sides',
      state: 'done',
      time: '21m',
      work: [
        {
          kind: 'diff',
          file: 'src/renderer/src/features/inspector/diff/parseHunks.ts',
          add: 31,
          del: 9,
          lines: [
            { n: 14, sign: '−', text: 'let oldLine = 1, newLine = 1' },
            { n: 14, sign: '+', text: 'const [, oldStart, , newStart] = HUNK_RE.exec(header) ?? []' },
            { n: 15, sign: '+', text: 'let oldLine = Number(oldStart), newLine = Number(newStart)' }
          ]
        }
      ]
    },
    {
      title: 'Verify against real diffs',
      state: 'done',
      time: '13m',
      work: [
        {
          kind: 'terminal',
          command: 'pnpm vitest run tests/renderer/inspector/diff',
          lines: ['Test Files  3 passed (3)', '     Tests  14 passed (14)'],
          exit: 0
        }
      ]
    }
  ],
  result: {
    summary:
      'Diffs now number every line from the file itself. The parser kept the @@ header all along but threw away its numbers; it reads them now, and split view numbers each side on its own.',
    receipt: 'Done · 42m · 4/4 checks · 1.2M tok · 91% cache'
  },
  files: [
    { path: 'src/renderer/src/features/inspector/diff/parseHunks.ts', add: 31, del: 9, status: 'M' },
    { path: 'src/renderer/src/features/inspector/diff/DiffView.tsx', add: 18, del: 3, status: 'M' },
    { path: 'tests/renderer/inspector/diff/diffGutter.test.tsx', add: 39, del: 0, status: 'A' }
  ]
}

function stub(id: string, title: string, state: TaskState, group: Task['group'], meta: string): Task {
  return {
    id,
    title,
    state,
    group,
    meta,
    elapsed: '',
    brief: title + '.',
    checks: [],
    steps: [],
    files: []
  }
}

export const TASKS: Task[] = [
  KEYS,
  COMPOSER,
  stub('audit', 'Audit how often runs check their own edits', 'running', 'running', '1/3'),
  DIFFS,
  stub('release', 'Release waits for CI on the tagged commit', 'review', 'review', '+136 −39'),
  stub('electron', 'Bump Electron to 44', 'done', 'done', 'Tue'),
  stub('notes', 'Write the v1.0 release notes', 'done', 'done', 'Mon')
]

export const GROUPS: Array<{ id: Task['group']; label: string }> = [
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Ready for review' },
  { id: 'done', label: 'Done' }
]

/** One file, as the File sheet shows it. `edited` lines carry the + gutter. */
export const SOURCE: Record<string, { lines: string[]; edited: number[] }> = {
  [FILE_TREE[0]]: {
    edited: [43, 44, 46, 47],
    lines: [
      "import { useEffect, useRef } from 'react'",
      "import { Count } from '@renderer/lib/ui'",
      "import { MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_SURFACE_SCROLL } from '@renderer/lib/ui/menuStyles'",
      "import { MentionEmpty, MentionError, MentionIcon, type MentionItem, type MentionView } from './mentionParts'",
      "import { useDropdownPlacement } from './composerDropdownLayout'",
      'type Props = {',
      '  view: MentionView',
      '  active: number',
      '  onPick: (item: MentionItem) => void',
      '}',
      '',
      '/**',
      ' * The @ menu. Files and folders share one list; a folder row carries',
      ' * the number of entries a pick will resolve to.',
      ' */',
      'export function MentionMenu({ view, active, onPick }: Props) {',
      '  const ref = useRef<HTMLUListElement>(null)',
      '  const place = useDropdownPlacement(ref, {',
      '    anchor: view.anchor,',
      '    gap: 6,',
      '    // Clamp to the window, not the composer: at 800px the',
      '    // composer is narrower than the menu wants to be.',
      '    boundary: "viewport",',
      '    minWidth: 320,',
      '    maxWidth: 560',
      '  })',
      '',
      '  useEffect(() => {',
      '    ref.current',
      '      ?.querySelector(`[data-index="${active}"]`)',
      '      ?.scrollIntoView({ block: "nearest" })',
      '  }, [active])',
      '',
      '  if (view.error) {',
      '    // The walk failed: say so instead of showing an empty list.',
      '    return <MentionError reason={view.error} />',
      '  }',
      '  if (view.items.length === 0) {',
      '    return <MentionEmpty query={view.query} />',
      '  }',
      '',
      '  const rows = view.items.map((item, i) => (',
      '    <li className={i === active ? MENU_ROW_ACTIVE : MENU_ROW_IDLE}',
      '        onPointerDown={() => onPick(item)}>',
      '      <MentionIcon kind={item.kind} />',
      '      <span className="truncate">{item.label}</span>',
      '      {item.kind === "folder" && <Count n={item.count} />}',
      '    </li>',
      '  ))',
      '  return <ul className={MENU_SURFACE_SCROLL}>{rows}</ul>',
      '}'
    ]
  }
}

/* ─── Plan, pull request, places ───────────────────────────────────────────── */

export const PLAN = {
  title: 'Redesign the / and @ composer menus and fix @ file and folder picking',
  goal: 'Make the composer’s two popovers, the / command menu and the @ mention menu, clean, structured and responsive, and fix the defect that stops files and folders being picked from @.',
  scopeIn: [
    'SlashCommandMenu.tsx and slashCommandPresentation.ts',
    'MentionMenu.tsx, mentionModel.ts and useComposerMentions.ts',
    'The IPC behind the mention list (register.ts, fileListCache.ts), only if folders need it',
    'Tests under tests/renderer/composer and tests/main/unit'
  ],
  scopeOut: ['The record’s own layout', 'The model picker and the mode picker'],
  risks: ['A folder pick resolving thousands of entries: cap it at 200 and say so in the chip.']
} as const

export const PR = {
  branch: 'claude/composer-menus',
  base: 'main',
  title: 'Redesign the / and @ composer menus',
  checks: [
    { name: 'lint', state: 'done' as const, time: '1m 12s' },
    { name: 'typecheck', state: 'done' as const, time: '2m 03s' },
    { name: 'unit · windows', state: 'running' as const, time: '4m' },
    { name: 'unit · macos', state: 'done' as const, time: '3m 41s' },
    { name: 'gui-e2e · linux', state: 'queued' as const, time: '' }
  ]
}

export const WORKSPACES = [
  { name: 'VYOTIQ – AGENT V', branch: 'main', changed: 152, ahead: 1, status: 'ok' as const, note: 'indexing' },
  { name: 'home', branch: '', changed: 0, ahead: 0, status: 'error' as const, note: 'Git status took too long' }
]

export const WEEK = {
  days: ['Th', 'Fr', 'Sa', 'Su', 'Mo', 'Tu', 'We'],
  tasks: [0, 0, 0, 0, 1, 5, 1],
  tokens: [0, 0, 0, 0, 4.1, 58.6, 12.3],
  totals: { tasks: 7, tokens: '75M', cache: '85%', spend: '—', finished: '86%', stopped: 1 }
}

export const MODEL_MIX = [{ id: 'space-bunny-free', share: 1 }]

export const TOOL_FAILURES = [
  { tool: 'await_agent_instance', why: 'Timed out waiting for the child', fails: 61, calls: 161 },
  { tool: 'terminal', why: 'exit 1 · pnpm exec vitest', fails: 12, calls: 80 },
  { tool: 'run_tests', why: 'pnpm exec vitest run failed', fails: 9, calls: 45 },
  { tool: 'check_done_when', why: 'Evidence too brief', fails: 6, calls: 22 },
  { tool: 'diagnostics', why: 'pnpm run lint --if-present rejected', fails: 3, calls: 13 }
]

export const EXTENSIONS = [
  { id: 'docx', name: 'Word documents', kind: 'Skill', note: 'Read and write .docx', on: true },
  { id: 'pdf', name: 'PDF', kind: 'Skill', note: 'Extract, fill and merge PDFs', on: true },
  { id: 'playwright', name: 'Playwright', kind: 'MCP', note: 'Drive a browser from a task', on: false },
  { id: 'github', name: 'GitHub', kind: 'MCP', note: 'Issues, pull requests, checks', on: true },
  { id: 'linear', name: 'Linear', kind: 'MCP', note: 'Needs sign-in', on: false }
]
