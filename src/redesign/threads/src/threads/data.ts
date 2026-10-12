/*
  One set of threads, rendered by all three directions, so the comparison is
  about the design and never about the data. Every thread has its own work;
  none borrows another's.
*/

export type TurnState = 'running' | 'needs' | 'done' | 'failed' | 'stopped'
export type StepState = 'done' | 'running' | 'needs' | 'failed' | 'stopped' | 'queued'

export type DiffLine = { t: '+' | '-' | ' '; s: string }

export type Work =
  | { kind: 'thought'; text: string; secs: number }
  | { kind: 'read'; paths: string[] }
  | { kind: 'search'; query: string; hits: number }
  | { kind: 'command'; cmd: string; out: string[]; exit?: number; secs?: number; live?: boolean; shown?: number }
  | { kind: 'edit'; path: string; add: number; del: number; created?: boolean; hunk: DiffLine[] }
  | { kind: 'approval'; cmd: string; why: string; answer?: 'once' | 'always' | 'deny' }
  /** Something you sent while it worked, delivered into the live step. */
  | { kind: 'steer'; text: string; attachments?: string[] }

export type Step = { title: string; state: StepState; secs?: number; work: Work[] }
export type FileChange = { path: string; add: number; del: number; created?: boolean }
export type Check = { text: string; state: 'met' | 'unmet' | 'open'; evidence?: string }

export type Turn = {
  id: string
  ask: string
  at: string
  mode: 'agent' | 'ask'
  state: TurnState
  steps: Step[]
  /** GitHub-flavoured markdown, rendered by markdown.tsx (code cards, file chips, tables, alerts, diagrams…). */
  answer?: string
  files: FileChange[]
  checks: Check[]
  secs: number
  cost: number
  /** When a live turn started (epoch ms), so its timer survives a remount. */
  startedAt?: number
  /** When its answer began streaming (epoch ms). Absent: the answer is whole. */
  streamStart?: number
  attachments?: string[]
  /** The model it ran on; absent means the default. */
  model?: string
  rating?: 'up' | 'down'
  error?: { title: string; detail: string; where: string; hint?: string }
}

export type Thread = {
  id: string
  title: string
  workspace: string
  branch: string
  age: string
  day: 'today' | 'yesterday' | 'earlier'
  unread?: boolean
  /** What you did with its edits after review. Absent: still to review. */
  settled?: 'kept' | 'undone'
  turns: Turn[]
}

export const MODELS = ['Sonnet 5.5', 'Opus 5.5', 'Haiku 4.5'] as const
export const MODEL = MODELS[0]
export const EFFORT = 'High'

const done = (title: string, secs: number, work: Work[]): Step => ({ title, state: 'done', secs, work })

/* ─── Rate limiting — live, step 3 of 4, tests streaming ─────────────────── */

const rate: Thread = {
  id: 'rate',
  title: 'Rate-limit the public API',
  workspace: 'api-gateway',
  branch: 'main',
  age: 'now',
  day: 'today',
  turns: [
    {
      id: 'rate-1',
      ask: 'Add rate limiting to the public API: 100 requests a minute per key, and a 429 with Retry-After past that. Done when the tests pass and the 101st request gets a 429.',
      at: '10:42',
      mode: 'agent',
      state: 'running',
      secs: 154,
      cost: 0.14,
      files: [
        { path: 'src/middleware/rateLimit.ts', add: 64, del: 0, created: true },
        { path: 'src/server.ts', add: 3, del: 1 },
        { path: 'tests/rateLimit.test.ts', add: 48, del: 0, created: true }
      ],
      checks: [
        { text: 'The api tests pass', state: 'open' },
        { text: 'The 101st request in a minute gets a 429 with Retry-After', state: 'open' }
      ],
      steps: [
        done('Read the request pipeline', 38, [
          { kind: 'read', paths: ['src/server.ts', 'src/middleware/auth.ts', 'src/routes/public.ts'] },
          { kind: 'search', query: 'app.use(', hits: 6 },
          {
            kind: 'thought',
            secs: 4,
            text: 'Auth runs before every public route and already resolves the API key, so the limiter can key on `req.apiKey` right after it — no second lookup.'
          }
        ]),
        done('Add the limiter middleware', 64, [
          {
            kind: 'edit',
            path: 'src/middleware/rateLimit.ts',
            add: 64,
            del: 0,
            created: true,
            hunk: [
              { t: '+', s: "import type { RequestHandler } from 'express'" },
              { t: '+', s: '' },
              { t: '+', s: 'const WINDOW_MS = 60_000' },
              { t: '+', s: 'const LIMIT = 100' },
              { t: '+', s: '' },
              { t: '+', s: 'export function rateLimit(store = new Map<string, number[]>()): RequestHandler {' },
              { t: '+', s: '  return (req, res, next) => {' },
              { t: '+', s: '    const now = Date.now()' },
              { t: '+', s: '    const hits = (store.get(req.apiKey) ?? []).filter((t) => now - t < WINDOW_MS)' }
            ]
          },
          {
            kind: 'edit',
            path: 'src/server.ts',
            add: 3,
            del: 1,
            hunk: [
              { t: ' ', s: "app.use('/v1', auth())" },
              { t: '-', s: "app.use('/v1', publicRoutes)" },
              { t: '+', s: "app.use('/v1', rateLimit())" },
              { t: '+', s: "app.use('/v1', publicRoutes)" }
            ]
          }
        ]),
        {
          title: 'Cover it with tests',
          state: 'running',
          work: [
            {
              kind: 'edit',
              path: 'tests/rateLimit.test.ts',
              add: 48,
              del: 0,
              created: true,
              hunk: [
                { t: '+', s: "it('answers the 101st request with 429', async () => {" },
                { t: '+', s: '  for (let i = 0; i < 100; i++) await get(app, KEY).expect(200)' },
                { t: '+', s: "  await get(app, KEY).expect(429).expect('retry-after', /\\d+/)" },
                { t: '+', s: '})' }
              ]
            },
            {
              kind: 'command',
              cmd: 'pnpm test --filter api',
              live: true,
              shown: 3,
              out: [
                '> api@2.4.0 test',
                '> vitest run',
                '',
                ' ✓ tests/auth.test.ts (12 tests) 214ms',
                ' ✓ tests/routes.test.ts (31 tests) 486ms',
                ' ✓ tests/rateLimit.test.ts > counts per key',
                ' ✓ tests/rateLimit.test.ts > answers the 101st request with 429',
                ' ✓ tests/rateLimit.test.ts > resets after the window',
                '',
                ' Test Files  3 passed (3)',
                '      Tests  46 passed (46)'
              ]
            }
          ]
        },
        { title: 'Document the limits in the API reference', state: 'queued', work: [] }
      ]
    }
  ]
}

/* ─── Flaky e2e — waiting on an approval ─────────────────────────────────── */

const flaky: Thread = {
  id: 'flaky',
  title: 'Fix the flaky checkout e2e',
  workspace: 'storefront',
  branch: 'fix/checkout-e2e',
  age: '4m',
  day: 'today',
  turns: [
    {
      id: 'flaky-1',
      ask: 'The checkout e2e fails about one run in three on CI. Find out why and make it reliable.',
      at: '10:31',
      mode: 'agent',
      state: 'needs',
      secs: 212,
      cost: 0.19,
      files: [],
      checks: [{ text: 'checkout.spec passes 20 runs in a row', state: 'open' }],
      steps: [
        done('Reproduce the failure', 141, [
          {
            kind: 'command',
            cmd: 'pnpm e2e checkout --repeat-each 10',
            exit: 1,
            secs: 118,
            out: [
              'Running 10 tests using 4 workers',
              '  ✘ checkout.spec.ts:42 › pays with a saved card (retry #3)',
              '    TimeoutError: locator.click: Timeout 5000ms exceeded.',
              '    waiting for frameLocator(\'iframe[name="pay"]\').getByRole(\'button\', { name: \'Pay\' })',
              '  3 failed',
              '  7 passed (1.9m)'
            ]
          },
          { kind: 'read', paths: ['e2e/checkout.spec.ts', 'e2e/fixtures/payment.ts'] },
          {
            kind: 'thought',
            secs: 6,
            text: 'It only fails when the payment iframe finishes loading after the click is queued. The headless shell here skips the iframe’s lazy load, so I need full Chromium to see it the way CI does.'
          }
        ]),
        {
          title: 'Run it against full Chromium',
          state: 'needs',
          work: [
            {
              kind: 'approval',
              cmd: 'pnpm exec playwright install chromium',
              why: 'Downloads Chromium (~150 MB) into the Playwright cache. It changes nothing in the repo.'
            }
          ]
        },
        { title: 'Wait on the iframe, not a timer', state: 'queued', work: [] }
      ]
    }
  ]
}

/* ─── Dark mode — two turns, finished, ready for review ──────────────────── */

const dark: Thread = {
  id: 'dark',
  title: 'Add dark mode to the settings page',
  workspace: 'storefront',
  branch: 'feat/settings-dark',
  age: '22m',
  day: 'today',
  unread: true,
  turns: [
    {
      id: 'dark-1',
      ask: 'Add a dark mode to the settings page. Follow the system by default, with a Light / Dark / System switch at the top.',
      at: '09:58',
      mode: 'agent',
      state: 'done',
      secs: 251,
      cost: 0.22,
      files: [
        { path: 'src/theme/tokens.css', add: 41, del: 6 },
        { path: 'src/settings/AppearanceSwitch.tsx', add: 58, del: 0, created: true },
        { path: 'src/settings/SettingsPage.tsx', add: 9, del: 3 },
        { path: 'src/theme/useTheme.ts', add: 20, del: 13 }
      ],
      checks: [
        { text: 'Settings renders in light and dark', state: 'met', evidence: 'settings.visual.spec · 2 snapshots match' },
        { text: 'System is the default', state: 'met', evidence: 'useTheme.test.ts › defaults to system' }
      ],
      steps: [
        done('Find how the theme is applied', 46, [
          { kind: 'read', paths: ['src/theme/tokens.css', 'src/theme/useTheme.ts', 'src/settings/SettingsPage.tsx'] },
          { kind: 'search', query: 'prefers-color-scheme', hits: 0 }
        ]),
        done('Add the dark tokens and the switch', 132, [
          {
            kind: 'edit',
            path: 'src/theme/tokens.css',
            add: 41,
            del: 6,
            hunk: [
              { t: ' ', s: ':root {' },
              { t: '-', s: '  --bg: #ffffff;' },
              { t: '+', s: '  --bg: light-dark(#ffffff, #111214);' },
              { t: '+', s: '  color-scheme: light dark;' }
            ]
          },
          { kind: 'edit', path: 'src/settings/AppearanceSwitch.tsx', add: 58, del: 0, created: true, hunk: [] },
          { kind: 'edit', path: 'src/settings/SettingsPage.tsx', add: 9, del: 3, hunk: [] },
          { kind: 'edit', path: 'src/theme/useTheme.ts', add: 20, del: 13, hunk: [] }
        ]),
        done('Check both themes', 73, [
          {
            kind: 'command',
            cmd: 'pnpm test settings',
            exit: 0,
            secs: 41,
            out: [' ✓ useTheme.test.ts (4 tests)', ' ✓ settings.visual.spec.ts (2 snapshots)', '', ' Tests  6 passed (6)']
          }
        ])
      ],
      answer: [
        'The settings page now follows the system theme, with a **Light / Dark / System** switch at the top.',
        '- Colours come from `light-dark()` pairs in `tokens.css`, so every surface switches without a second stylesheet.',
        '- `useTheme` stores the choice and sets `color-scheme` on the root; System clears it.',
        '- The switch is a radio group, so arrow keys move between the three options.',
        'Both themes are covered by a visual snapshot, and the default is tested.'
      ].join('\n\n')
    },
    {
      id: 'dark-2',
      ask: 'Also remember the choice between launches.',
      at: '10:19',
      mode: 'agent',
      state: 'done',
      secs: 64,
      cost: 0.05,
      files: [
        { path: 'src/theme/useTheme.ts', add: 11, del: 2 },
        { path: 'tests/useTheme.test.ts', add: 18, del: 0 }
      ],
      checks: [{ text: 'The choice survives a reload', state: 'met', evidence: 'useTheme.test.ts › restores the saved choice' }],
      steps: [
        done('Persist the choice', 64, [
          { kind: 'read', paths: ['src/theme/useTheme.ts'] },
          {
            kind: 'edit',
            path: 'src/theme/useTheme.ts',
            add: 11,
            del: 2,
            hunk: [
              { t: '-', s: "const [mode, setMode] = useState<Mode>('system')" },
              { t: '+', s: "const [mode, setMode] = useState<Mode>(() => readSaved() ?? 'system')" },
              { t: '+', s: "useEffect(() => localStorage.setItem('theme', mode), [mode])" }
            ]
          },
          { kind: 'edit', path: 'tests/useTheme.test.ts', add: 18, del: 0, hunk: [] },
          { kind: 'command', cmd: 'pnpm test useTheme', exit: 0, secs: 6, out: [' ✓ useTheme.test.ts (5 tests)', '', ' Tests  5 passed (5)'] }
        ])
      ],
      answer:
        'The choice is saved to `localStorage` and read back before the first paint, so there is no flash of the wrong theme on launch. Choosing **System** saves `system`, not the current OS theme, so it keeps following the OS.'
    }
  ]
}

/* ─── Build time — Ask mode, an answer and nothing changed ───────────────── */

const build: Thread = {
  id: 'build',
  title: 'Why is the build 40s slower?',
  workspace: 'storefront',
  branch: 'main',
  age: '1h',
  day: 'today',
  turns: [
    {
      id: 'build-1',
      ask: 'The production build went from 52s to 94s this week. Why?',
      at: '09:12',
      mode: 'ask',
      state: 'done',
      secs: 97,
      cost: 0.06,
      files: [],
      checks: [],
      steps: [
        done('Profile the build', 97, [
          { kind: 'command', cmd: 'pnpm build --profile', exit: 0, secs: 91, out: ['vite v7.1.4 building for production...', '✓ 2,814 modules transformed.', 'icons/index.ts  38.2s'] },
          { kind: 'search', query: "from '@phosphor-icons/react'", hits: 112 },
          { kind: 'read', paths: ['src/icons/index.ts', 'vite.config.ts'] }
        ])
      ],
      answer: [
        'Almost all of it is one file: `src/icons/index.ts` now takes **38s** to transform, up from under a second.',
        '| Stage | Last week | Now |\n| --- | ---: | ---: |\n| Transform | 14.1s | 52.3s |\n| Bundle | 21.6s | 23.0s |\n| Minify | 16.4s | 18.7s |\n| **Total** | **52.1s** | **94.0s** |',
        'Tuesday’s change replaced the named icon imports with a namespace import:',
        "```ts\n// src/icons/index.ts\nimport * as Phosphor from '@phosphor-icons/react'\n\nexport const ICONS = {\n  check: Phosphor.Check,\n  close: Phosphor.X\n}\n```",
        'A namespace import stops tree-shaking, so Vite transforms all **9,000** icons instead of the 140 the app uses. Two ways back:',
        '1. Import each icon by name again — the old file did this.\n2. Keep the namespace import but point it at `@phosphor-icons/react/dist/ssr`, which ships one module per icon.',
        'Either should bring the build back to about **52s**.'
      ].join('\n\n')
    }
  ]
}

/* ─── Sessions — an Ask answer that needs every element ──────────────────── */

export const SESSION_ANSWER = [
  'Sessions that are **refreshed** expire early. Every request goes through `auth()` in `src/auth/middleware.ts`, and when a session is close to its end, the refresh tells the store to keep it for 30 *seconds* instead of 30 minutes.',
  '## How a request is authenticated',
  '```mermaid\nsequenceDiagram\n  participant C as Client\n  participant A as auth()\n  participant S as Session store\n  participant R as Route\n  C->>A: GET /v1/orders (cookie sid)\n  A->>S: get(sid)\n  S-->>A: session, expiresAt\n  alt ends within 5 minutes\n    A->>S: touch(sid)\n  end\n  A->>R: req.user\n  R-->>C: 200 OK\n```',
  '1. `auth()` reads `sid` from the cookie and loads the session — `src/auth/session.ts:41`.\n2. A missing or expired session gets **401** straight away; the route never runs.\n3. A session ending within five minutes is refreshed by `touch()` before the request carries on.',
  '## Why refreshed sessions end early',
  '`touch()` sets the right expiry on the session, then passes the wrong unit to the store:',
  "```ts src/auth/session.ts:58-63\nexport async function touch(sid: string, session: Session): Promise<void> {\n  session.expiresAt = nowSeconds() + REFRESH_SECONDS\n  // The store's ttl is in seconds.\n  await store.set(sid, session, { ttl: REFRESH_MINUTES })\n}\n```",
  'So the session *says* it has 30 minutes left, but the store deletes it after 30 seconds:',
  '| Session | `expiresAt` says | Store deletes it after |\n| --- | ---: | ---: |\n| New sign-in | 30 min | 1,800 s |\n| Refreshed once | 30 min | 30 s |\n| Refreshed again | 30 min | 30 s |',
  'Yesterday’s 401s follow the same shape — they climb with traffic, not with time since sign-in:',
  '```chart\n{"type":"bar","title":"401 responses per two hours, yesterday","labels":["00","02","04","06","08","10","12","14","16","18","20","22"],"values":[12,8,6,9,41,96,118,104,121,87,44,19]}\n```',
  '> [!WARNING]\n> The people signed out are the **active** ones. A session is only refreshed while someone is using it, so a quiet tab keeps its full 30 minutes.',
  '## The fix',
  'One word in `touch()`:',
  '```diff\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -58,6 +58,6 @@ export async function touch(sid: string, session: Session)\n   session.expiresAt = nowSeconds() + REFRESH_SECONDS\n   // The store\'s ttl is in seconds.\n-  await store.set(sid, session, { ttl: REFRESH_MINUTES })\n+  await store.set(sid, session, { ttl: REFRESH_SECONDS })\n }\n```',
  'To check it after the change, run the auth tests and read a refreshed session’s TTL:',
  '```sh\n$ pnpm test --filter auth\n ✓ tests/auth.test.ts (19 tests) 412ms\n$ redis-cli TTL session:4f2a9c\n(integer) 1800\n```',
  'To see the bug first: sign in, wait for the five-minute window, press <kbd>F5</kbd> once to trigger a refresh, then press it again 30 seconds later — you are signed out.',
  '### What I checked',
  '- [x] A new sign-in stores a 1,800 s TTL — `tests/auth.test.ts` covers it\n- [x] `touch()` is the only code that refreshes a TTL\n- [ ] No test covers a refreshed session’s TTL — worth adding with the fix',
  '<details>\n<summary>Every call to store.set</summary>\n\n- `src/auth/session.ts:33` — sign-in, `ttl: SESSION_SECONDS`\n- `src/auth/session.ts:61` — refresh, `ttl: REFRESH_MINUTES`\n- `src/admin/impersonate.ts:18` — admin impersonation, `ttl: 300`\n\n</details>'
].join('\n\n')

const session: Thread = {
  id: 'session',
  title: 'Why do sessions expire early?',
  workspace: 'api',
  branch: 'main',
  age: '20m',
  day: 'today',
  turns: [
    {
      id: 'session-1',
      ask: 'Some users get signed out after a few minutes even though sessions should last 30. How does auth work here, and why does that happen?',
      at: '10:41',
      mode: 'ask',
      state: 'done',
      secs: 71,
      cost: 0.05,
      files: [],
      checks: [],
      steps: [
        done('Trace a request through auth', 38, [
          { kind: 'read', paths: ['src/auth/middleware.ts', 'src/auth/session.ts', 'src/server.ts'] },
          { kind: 'search', query: 'store.set(', hits: 3 },
          { kind: 'read', paths: ['src/admin/impersonate.ts', 'tests/auth.test.ts'] }
        ]),
        done('Check yesterday’s 401s', 33, [
          { kind: 'command', cmd: "rg -c ' 401 ' logs/api-2026-10-06.log", exit: 0, secs: 2, out: ['665'] },
          { kind: 'thought', secs: 4, text: 'The 401s track traffic, not session age — refreshed sessions are the ones dying. touch() passes REFRESH_MINUTES where the store wants seconds.' }
        ])
      ],
      answer: SESSION_ANSWER
    }
  ]
}

/* ─── OAuth — failed mid-run ─────────────────────────────────────────────── */

const oauth: Thread = {
  id: 'oauth',
  title: 'Move sign-in to OAuth PKCE',
  workspace: 'api-gateway',
  branch: 'feat/pkce',
  age: '2h',
  day: 'today',
  turns: [
    {
      id: 'oauth-1',
      ask: 'Replace the password grant with OAuth authorization code + PKCE. Keep existing sessions working.',
      at: '08:40',
      mode: 'agent',
      state: 'failed',
      secs: 188,
      cost: 0.17,
      files: [
        { path: 'src/auth/pkce.ts', add: 52, del: 0, created: true },
        { path: 'src/auth/routes.ts', add: 34, del: 19 }
      ],
      checks: [{ text: 'The auth tests pass', state: 'unmet', evidence: 'pnpm test --filter auth · exit 1' }],
      steps: [
        done('Add the PKCE flow', 121, [
          { kind: 'read', paths: ['src/auth/routes.ts', 'src/auth/session.ts'] },
          { kind: 'edit', path: 'src/auth/pkce.ts', add: 52, del: 0, created: true, hunk: [] },
          { kind: 'edit', path: 'src/auth/routes.ts', add: 34, del: 19, hunk: [] }
        ]),
        {
          title: 'Run the auth tests',
          state: 'failed',
          secs: 67,
          work: [
            {
              kind: 'command',
              cmd: 'pnpm test --filter auth',
              exit: 1,
              secs: 9,
              out: [
                ' ✓ tests/pkce.test.ts (8 tests)',
                ' ✘ tests/session.test.ts',
                '   Error: connect ECONNREFUSED 127.0.0.1:6379',
                '     at TCPConnectWrap.afterConnect',
                '',
                ' Test Files  1 failed | 1 passed (2)'
              ]
            }
          ]
        },
        { title: 'Migrate existing sessions', state: 'queued', work: [] }
      ],
      error: {
        title: 'Redis refused the connection',
        detail: 'The session tests need Redis at 127.0.0.1:6379, and nothing is listening there.',
        where: 'Step 2 · pnpm test --filter auth',
        hint: 'Start Redis and retry, or ask it to mock Redis in the session tests.'
      }
    }
  ]
}

/* ─── Older, settled threads — short, so the list has a real history ────── */

function settled(id: string, title: string, workspace: string, age: string, day: Thread['day'], ask: string, answer: string, files: FileChange[]): Thread {
  return {
    id,
    title,
    workspace,
    branch: 'main',
    age,
    day,
    settled: 'kept',
    turns: [
      {
        id: `${id}-1`,
        ask,
        at: day === 'yesterday' ? 'Yesterday' : 'Mon',
        mode: 'agent',
        state: 'done',
        secs: 140,
        cost: 0.11,
        files,
        checks: [],
        steps: [done('Make the change', 140, [{ kind: 'read', paths: files.map((f) => f.path) }, ...files.map((f): Work => ({ kind: 'edit', path: f.path, add: f.add, del: f.del, hunk: [] }))])],
        answer
      }
    ]
  }
}

export const THREADS: Thread[] = [
  flaky,
  rate,
  session,
  dark,
  build,
  oauth,
  settled(
    'electron',
    'Bump Electron to 44',
    'desktop',
    '1d',
    'yesterday',
    'Bump Electron to 44 and fix whatever breaks.',
    'Electron is on **44.0.2**. Two things broke and are fixed: `webContents.getPrinters()` is async now, and the `--no-sandbox` flag is no longer needed for the e2e.',
    [
      { path: 'package.json', add: 1, del: 1 },
      { path: 'src/main/print.ts', add: 6, del: 4 }
    ]
  ),
  settled(
    'notes',
    'Write the 1.1 release notes',
    'desktop',
    '1d',
    'yesterday',
    'Write release notes for 1.1 from the commits since 1.0.',
    'The notes are in `CHANGELOG.md` under **1.1.0**: 6 features, 11 fixes, grouped by area, each linked to its commit.',
    [{ path: 'CHANGELOG.md', add: 38, del: 0 }]
  ),
  settled(
    'index',
    'Speed up the file index',
    'desktop',
    '3d',
    'earlier',
    'Opening a large repo freezes the window for a few seconds. Make the file index faster.',
    'The index now walks the tree off the main thread and skips ignored folders before it reads them. A 40k-file repo opens in **0.6s**, down from 4.1s.',
    [
      { path: 'src/main/index/walk.ts', add: 71, del: 38 },
      { path: 'src/main/index/worker.ts', add: 44, del: 0, created: true }
    ]
  ),
  settled(
    'status',
    'Remove the old status bar',
    'desktop',
    '5d',
    'earlier',
    'Remove the status bar; everything on it lives elsewhere now.',
    'The status bar is gone. Its last two items — the branch and the sync state — were already in the title bar, so nothing moved.',
    [
      { path: 'src/renderer/StatusBar.tsx', add: 0, del: 112 },
      { path: 'src/renderer/App.tsx', add: 1, del: 4 }
    ]
  )
]

/* ─── Canned replies for what you send in the mockup ─────────────────────── */

const short = (ask: string): string => (ask.length > 60 ? `${ask.slice(0, 57).trimEnd()}…` : ask)

/** The answer to a follow-up, about `file` — a file the thread already worked on. */
export function cannedAnswer(ask: string, mode: 'agent' | 'ask', file: string): string {
  const name = file.split('/').pop() ?? file
  return mode === 'ask'
    ? [
        `Here is what I found about “${short(ask)}”.`,
        `The part that matters lives in \`${file}\`; everything else reads from it.`,
        `Nothing in the workspace was changed. Switch to **Agent** if you want me to make a change.`
      ].join('\n\n')
    : [`Done — “${short(ask)}”.`, `- The change is in \`${file}\`.\n- The tests that cover \`${name}\` still pass.`, 'Say the word if you want a test for it too.'].join('\n\n')
}
