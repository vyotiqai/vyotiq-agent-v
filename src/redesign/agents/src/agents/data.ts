import type { TaskState } from '@renderer/lib/ui'

/*
  Sample data for the mockups: a made-up monorepo (acme) and app
  (acme-mobile), never real runs, spend or paths. Every field is one the app
  already keeps on disk — status, todos.json steps, checks.json, write
  checkpoints, usage — so nothing here needs a new source of truth.
*/

export type Check = { text: string; state: 'met' | 'unmet' | 'open'; evidence?: string }

export type Instance = { id: string; title: string; state: TaskState; verb: string; items: Item[] }

export type Outcome = { kind: 'kept' | 'undone' | 'committed'; files: number; sha?: string }

export type Agent = {
  id: string
  title: string
  state: TaskState
  age: string
  workspace: string
  branch: string
  worktree?: boolean
  /** The second line: what it is doing now, or what it left. */
  line: string
  diff?: { add: number; del: number }
  step?: [number, number]
  checks?: [number, number]
  ask?: { kind: 'command' | 'question'; text: string }
  unread?: boolean
  pinned?: boolean
  archived?: boolean
  outcome?: Outcome
  model: string
  cost: string
  /** Settled tasks are grouped by day. */
  day?: 'Today' | 'Yesterday'
}

export const WORKSPACES = [
  { name: 'acme', path: '~/code/acme' },
  { name: 'acme-mobile', path: '~/code/acme-mobile' }
] as const

export const RECENT_FOLDERS = [{ name: 'api-gateway', path: '~/code/api-gateway' }] as const

export const BRANCHES = ['main', 'vyotiq/sessions-pg', 'vyotiq/auth-audit', 'release/1.0'] as const

export const AGENTS: Agent[] = [
  {
    id: 'plan-billing',
    title: 'Usage-based billing plan',
    state: 'needs',
    age: '1m',
    workspace: 'acme',
    branch: 'main',
    line: 'Asks: how should overages be billed?',
    ask: { kind: 'question', text: 'How should overages be billed?' },
    step: [1, 4],
    model: 'Opus 5.5',
    cost: '$0.21'
  },
  {
    id: 'migrate-sessions',
    title: 'Migrate sessions to Postgres',
    state: 'needs',
    age: '2m',
    workspace: 'acme',
    branch: 'vyotiq/sessions-pg',
    worktree: true,
    line: 'Wants to run pnpm db:migrate --env staging',
    ask: { kind: 'command', text: 'pnpm db:migrate --env staging' },
    step: [3, 5],
    model: 'GPT-5.6 Sol',
    cost: '$0.34'
  },
  {
    id: 'rate-limits',
    title: 'Add rate limits to public routes',
    state: 'running',
    age: '6m',
    workspace: 'acme',
    branch: 'main',
    line: 'Running pnpm test --filter api',
    step: [2, 4],
    diff: { add: 64, del: 7 },
    model: 'Opus 5.5',
    cost: '$0.19'
  },
  {
    id: 'audit-auth',
    title: 'Audit API routes for auth gaps',
    state: 'running',
    age: '9m',
    workspace: 'acme',
    branch: 'vyotiq/auth-audit',
    worktree: true,
    line: '2 of 3 instances working',
    step: [1, 3],
    model: 'Opus 5.5',
    cost: '$0.52'
  },
  {
    id: 'flaky-checkout',
    title: 'Fix flaky checkout e2e',
    state: 'running',
    age: '12m',
    workspace: 'acme',
    branch: 'main',
    line: 'Running pnpm e2e checkout --repeat 50',
    step: [1, 3],
    model: 'Fable 5.1',
    cost: '$0.07'
  },
  {
    id: 'pricing-toggle',
    title: 'Pricing page: annual toggle',
    state: 'review',
    age: '18m',
    workspace: 'acme',
    branch: 'main',
    line: 'Toggle, saved-percent badge, and the tests',
    diff: { add: 135, del: 21 },
    checks: [3, 3],
    unread: true,
    model: 'Opus 5.5',
    cost: '$0.44'
  },
  {
    id: 'webhook-retry',
    title: 'Retry failed billing webhooks',
    state: 'review',
    age: '42m',
    workspace: 'acme',
    branch: 'main',
    line: 'Exponential backoff with a dead-letter table',
    diff: { add: 96, del: 12 },
    checks: [2, 3],
    model: 'GPT-5.6 Sol',
    cost: '$0.58'
  },
  {
    id: 'bump-zod',
    title: 'Bump zod to 4.2',
    state: 'done',
    age: '3h',
    workspace: 'acme',
    branch: 'main',
    line: 'Committed 3f2a91c · 3 files',
    outcome: { kind: 'committed', files: 3, sha: '3f2a91c' },
    model: 'Qwen3 Coder',
    cost: '$0.00',
    day: 'Today'
  },
  {
    id: 'search-cache',
    title: 'Cache repository search results',
    state: 'failed',
    age: '5h',
    workspace: 'acme',
    branch: 'main',
    line: 'Failed at step 2: redis connection refused',
    diff: { add: 37, del: 1 },
    step: [2, 3],
    model: 'Opus 5.5',
    cost: '$0.16',
    day: 'Today'
  },
  {
    id: 'openapi-users',
    title: 'OpenAPI docs for /v1/users',
    state: 'done',
    age: '1d',
    workspace: 'acme',
    branch: 'main',
    line: 'Kept · 2 files',
    outcome: { kind: 'kept', files: 2 },
    pinned: true,
    model: 'Fable 5.1',
    cost: '$0.12',
    day: 'Yesterday'
  },
  {
    id: 'legacy-auth',
    title: 'Remove legacy auth middleware',
    state: 'stopped',
    age: '1d',
    workspace: 'acme',
    branch: 'main',
    line: 'Stopped by you at step 2',
    diff: { add: 1, del: 6 },
    step: [2, 3],
    model: 'Opus 5.5',
    cost: '$0.09',
    day: 'Yesterday'
  },
  {
    id: 'ios-redirect',
    title: 'Fix sign-in redirect on iOS',
    state: 'running',
    age: '4m',
    workspace: 'acme-mobile',
    branch: 'main',
    line: 'Rebuilding for the simulator',
    step: [2, 3],
    diff: { add: 9, del: 3 },
    model: 'Fable 5.1',
    cost: '$0.05'
  },
  {
    id: 'push-badges',
    title: 'Badge count on push notifications',
    state: 'review',
    age: '1h',
    workspace: 'acme-mobile',
    branch: 'main',
    line: 'Badge clears when the app opens',
    diff: { add: 31, del: 4 },
    checks: [2, 2],
    model: 'Opus 5.5',
    cost: '$0.22'
  },
  {
    id: 'app-icons',
    title: 'Regenerate app icons',
    state: 'done',
    age: '1d',
    workspace: 'acme-mobile',
    branch: 'main',
    line: 'Committed 8c01d4e · 14 files',
    outcome: { kind: 'committed', files: 14, sha: '8c01d4e' },
    model: 'Fable 5.1',
    cost: '$0.03',
    day: 'Yesterday'
  }
]

/* ─── The record ───────────────────────────────────────────────────────────── */

export type Look = { verb: string; obj: string }

export type Item =
  | { k: 'thought'; secs: number }
  | { k: 'look'; verb: string; obj: string }
  | { k: 'explored'; files: number; searches: number; items: Look[] }
  | { k: 'say'; text: string }
  | { k: 'edit'; path: string; add: number; del: number; created?: boolean }
  | { k: 'cmd'; cmd: string; state: 'running' | 'ok' | 'fail' | 'stopped'; exit?: number; time: string; out: string[] }
  | { k: 'approval'; cmd: string; why: string; allowAs: string }
  | { k: 'question'; n: number; of: number; q: string; options: string[] }
  | { k: 'instances' }
  | { k: 'error'; title: string; detail: string }
  | { k: 'live'; text: string }
  | { k: 'you'; text: string; kind: 'steer' | 'answer' }

export type Step = { n: number; title: string; state: TaskState; time?: string; items: Item[]; summary?: string }

export type RecordData = {
  brief: string
  attachments?: string[]
  checks: Check[]
  steps: Step[]
  /** Work before the plan existed. */
  setup?: Item[]
  result?: { text: string; receipt: string; files: { path: string; add: number; del: number }[] }
  worked?: string
  instances?: Instance[]
}

const RATE_LIMITS: RecordData = {
  brief:
    'Add rate limiting to every route under /v1/public. 100 requests a minute per API key, 20 per IP when there is no key. Return 429 with a Retry-After header.',
  checks: [
    { text: 'pnpm test --filter api passes', state: 'open' },
    { text: 'The 101st request in a minute returns 429', state: 'open' },
    { text: 'Every 429 carries Retry-After', state: 'open' }
  ],
  setup: [
    { k: 'thought', secs: 4 },
    {
      k: 'explored',
      files: 6,
      searches: 2,
      items: [
        { verb: 'Read', obj: 'src/server.ts' },
        { verb: 'Read', obj: 'src/routes/public/index.ts' },
        { verb: 'Searched', obj: 'rateLimit|throttle' },
        { verb: 'Read', obj: 'src/lib/redis.ts' },
        { verb: 'Read', obj: 'package.json' },
        { verb: 'Searched', obj: 'x-api-key' },
        { verb: 'Read', obj: 'src/middleware/auth.ts' },
        { verb: 'Read', obj: 'tests/public.test.ts' }
      ]
    },
    {
      k: 'say',
      text: 'Public routes mount in `src/routes/public/index.ts` and Redis is already a dependency, so I will use a sliding window in Redis rather than an in-memory counter that resets on every deploy.'
    }
  ],
  steps: [
    {
      n: 1,
      title: 'Write the limiter middleware',
      state: 'done',
      time: '2m 41s',
      summary: '1 edit · 1 lookup',
      items: [
        { k: 'look', verb: 'Read', obj: 'src/lib/redis.ts' },
        { k: 'edit', path: 'src/middleware/rateLimit.ts', add: 58, del: 0, created: true }
      ]
    },
    {
      n: 2,
      title: 'Mount it on /v1/public and test',
      state: 'running',
      time: '1m 12s',
      items: [
        { k: 'edit', path: 'src/routes/public/index.ts', add: 6, del: 7 },
        { k: 'say', text: 'Mounted before the handlers. Running the API tests now.' },
        {
          k: 'cmd',
          cmd: 'pnpm test --filter api',
          state: 'running',
          time: '14s',
          out: [
            ' RUN  v3.2.4 ~/code/acme',
            '',
            ' ✓ tests/health.test.ts (3 tests) 41ms',
            ' ✓ tests/users.test.ts (18 tests) 312ms',
            ' ✓ tests/billing.test.ts (22 tests) 488ms',
            ' ❯ tests/public.test.ts (9 tests)'
          ]
        }
      ]
    },
    { n: 3, title: 'Add a test for the 101st request', state: 'queued', items: [] },
    { n: 4, title: 'Check Retry-After on every 429', state: 'queued', items: [] }
  ]
}

const MIGRATE: RecordData = {
  brief: 'Move session storage from Redis to the Postgres sessions table. Keep existing sessions valid during the switch.',
  checks: [
    { text: 'Migration applies cleanly on staging', state: 'open' },
    { text: 'Logged-in users stay logged in', state: 'open' }
  ],
  steps: [
    {
      n: 1,
      title: 'Add the sessions table',
      state: 'done',
      time: '1m 50s',
      summary: '1 edit · 3 lookups',
      items: [
        { k: 'look', verb: 'Read', obj: 'src/db/schema.ts' },
        { k: 'look', verb: 'Read', obj: 'src/auth/sessionStore.ts' },
        { k: 'look', verb: 'Searched', obj: 'sess:' },
        { k: 'edit', path: 'src/db/schema.ts', add: 18, del: 0 }
      ]
    },
    {
      n: 2,
      title: 'Dual-write sessions',
      state: 'done',
      time: '4m 02s',
      summary: '1 edit · 2 commands',
      items: [
        { k: 'edit', path: 'src/auth/sessionStore.ts', add: 51, del: 10 },
        { k: 'cmd', cmd: 'pnpm db:generate', state: 'ok', exit: 0, time: '3.1s', out: ['✔ Generated migration 0043_sessions.sql'] },
        {
          k: 'cmd',
          cmd: 'pnpm test --filter api -- sessions',
          state: 'ok',
          exit: 0,
          time: '8.4s',
          out: [' ✓ tests/sessions.test.ts (14 tests) 402ms', '', ' Test Files  1 passed (1)', '      Tests  14 passed (14)']
        }
      ]
    },
    {
      n: 3,
      title: 'Apply the migration on staging',
      state: 'needs',
      time: '0m 20s',
      items: [
        {
          k: 'say',
          text: 'The migration only adds a table and an index, so it is safe to run while traffic is live. It needs the staging database URL from your environment.'
        },
        { k: 'approval', cmd: 'pnpm db:migrate --env staging', why: 'Changes the staging database', allowAs: 'pnpm db:migrate' }
      ]
    },
    { n: 4, title: 'Read sessions from Postgres', state: 'queued', items: [] },
    { n: 5, title: 'Remove the Redis session store', state: 'queued', items: [] }
  ]
}

const BILLING_PLAN: RecordData = {
  brief: 'Plan usage-based billing for the API: metered requests, monthly invoices through Stripe, and a usage page in the dashboard.',
  attachments: ['pricing-2026.pdf'],
  checks: [{ text: 'The plan names every table and endpoint it adds', state: 'open' }],
  setup: [
    { k: 'thought', secs: 7 },
    {
      k: 'explored',
      files: 9,
      searches: 3,
      items: [
        { verb: 'Read', obj: 'pricing-2026.pdf' },
        { verb: 'Read', obj: 'src/billing/stripe.ts' },
        { verb: 'Searched', obj: 'invoice' },
        { verb: 'Read', obj: 'src/db/schema.ts' },
        { verb: 'Searched', obj: 'usage' },
        { verb: 'Read', obj: 'web/dashboard/page.tsx' }
      ]
    },
    { k: 'edit', path: 'plans/usage-billing.md', add: 68, del: 0, created: true },
    { k: 'say', text: 'Drafted the plan in `plans/usage-billing.md`. Two questions before I build:' }
  ],
  steps: [
    {
      n: 1,
      title: 'Settle the open questions',
      state: 'needs',
      items: [
        {
          k: 'question',
          n: 1,
          of: 2,
          q: 'How should overages be billed?',
          options: ['Per 1,000 requests, invoiced monthly', 'Prepaid credit packs', 'Both — credits first, then metered']
        }
      ]
    },
    { n: 2, title: 'Add usage_events and a nightly rollup', state: 'queued', items: [] },
    { n: 3, title: 'Report usage to Stripe', state: 'queued', items: [] },
    { n: 4, title: 'Usage page in the dashboard', state: 'queued', items: [] }
  ]
}

/** The second question, shown after the first is answered. */
export const SECOND_QUESTION = {
  q: 'Do free keys get a hard cap or a soft one?',
  options: ['Hard cap: 429 at the limit', 'Soft cap: keep serving, email the owner', 'Hard cap, with a one-time grace of 10%']
}

export const INSTANCES: Instance[] = [
  {
    id: 'i-auth',
    title: 'src/routes/auth.ts',
    state: 'running',
    verb: 'Reading requireUser()',
    items: [
      { k: 'look', verb: 'Read', obj: 'src/routes/auth.ts' },
      { k: 'look', verb: 'Searched', obj: 'requireUser(' },
      { k: 'say', text: '`POST /auth/refresh` reads the session before `requireUser` runs. Checking whether that is intended before I call it a gap.' },
      { k: 'live', text: 'Reading src/middleware/auth.ts' }
    ]
  },
  {
    id: 'i-billing',
    title: 'src/routes/billing.ts',
    state: 'running',
    verb: 'Searching for session checks',
    items: [
      { k: 'look', verb: 'Read', obj: 'src/routes/billing.ts' },
      { k: 'thought', secs: 3 },
      { k: 'say', text: '`GET /billing/invoices/:id` checks the user is signed in, but not that the invoice is theirs.' },
      { k: 'live', text: 'Searching for session.userId' }
    ]
  },
  {
    id: 'i-webhooks',
    title: 'src/routes/webhooks.ts',
    state: 'done',
    verb: 'No gaps found',
    items: [
      { k: 'look', verb: 'Read', obj: 'src/routes/webhooks.ts' },
      { k: 'look', verb: 'Read', obj: 'src/billing/webhooks.ts' },
      { k: 'say', text: 'Webhooks verify the Stripe signature instead of a session, which is right for them. No gaps.' }
    ]
  }
]

const AUDIT: RecordData = {
  brief: 'Audit every route under src/routes for handlers that skip requireUser or check the wrong scope. Report first; fix only what is clear.',
  checks: [
    { text: 'Every route file is covered', state: 'open' },
    { text: 'Each gap it fixes has a failing test first', state: 'open' }
  ],
  setup: [
    { k: 'thought', secs: 5 },
    {
      k: 'explored',
      files: 14,
      searches: 3,
      items: [
        { verb: 'Listed', obj: 'src/routes' },
        { verb: 'Read', obj: 'src/middleware/auth.ts' },
        { verb: 'Searched', obj: 'router\\.(get|post|put|delete)' },
        { verb: 'Searched', obj: 'requireUser' },
        { verb: 'Searched', obj: 'requireScope' }
      ]
    },
    { k: 'say', text: '31 handlers across 3 route files. I gave each file to an instance and will merge what they find.' }
  ],
  steps: [
    { n: 1, title: 'Audit the routes in parallel', state: 'running', time: '4m 10s', items: [{ k: 'instances' }] },
    { n: 2, title: 'Merge the findings', state: 'queued', items: [] },
    { n: 3, title: 'Fix the clear gaps', state: 'queued', items: [] }
  ],
  instances: INSTANCES
}

const FLAKY: RecordData = {
  brief: 'The checkout e2e fails about one run in ten on CI. Find out why and fix it — do not just add retries.',
  checks: [{ text: 'Passes 50 runs in a row locally', state: 'open' }],
  setup: [{ k: 'thought', secs: 3 }],
  steps: [
    {
      n: 1,
      title: 'Reproduce the flake',
      state: 'running',
      time: '2m 05s',
      items: [
        { k: 'look', verb: 'Read', obj: 'web/e2e/checkout.spec.ts' },
        { k: 'look', verb: 'Read', obj: 'web/checkout/PayButton.tsx' },
        { k: 'say', text: 'Running it 50 times on 4 workers to see the failure for myself before touching anything.' },
        {
          k: 'cmd',
          cmd: 'pnpm e2e checkout --repeat 50',
          state: 'running',
          time: '1m 48s',
          out: [
            'Running 50 tests using 4 workers',
            '',
            '  ✓  1 checkout › pays with a saved card (3.2s)',
            '  ✓  2 checkout › pays with a saved card (3.4s)',
            '  ✗  7 checkout › pays with a saved card (30.0s)',
            "     Timeout 30000ms waiting for getByRole('button', { name: 'Pay' })",
            '  ✓  8 checkout › pays with a saved card (3.1s)'
          ]
        }
      ]
    },
    { n: 2, title: 'Fix the cause', state: 'queued', items: [] },
    { n: 3, title: 'Prove it: 50 green runs', state: 'queued', items: [] }
  ]
}

const WEBHOOK_RETRY: RecordData = {
  brief: 'Failed Stripe webhooks are dropped. Retry them with backoff, and park the ones that keep failing somewhere we can inspect.',
  checks: [
    { text: 'pnpm test --filter api passes', state: 'met', evidence: 'exit 0 · 71 tests' },
    { text: 'A webhook that fails 5 times lands in webhook_dead_letters', state: 'met', evidence: 'webhooks.test.ts › parks after 5 attempts' },
    { text: 'Retries never run twice for one event', state: 'unmet', evidence: 'No test covers two workers taking the same event' }
  ],
  steps: [
    {
      n: 1,
      title: 'Add webhook_attempts and dead letters',
      state: 'done',
      time: '3m 10s',
      summary: '1 edit · 3 lookups',
      items: [
        { k: 'look', verb: 'Read', obj: 'src/billing/webhooks.ts' },
        { k: 'look', verb: 'Read', obj: 'src/db/schema.ts' },
        { k: 'look', verb: 'Searched', obj: 'handleStripeEvent' },
        { k: 'edit', path: 'src/db/migrations/0042_webhook_attempts.sql', add: 24, del: 0, created: true }
      ]
    },
    {
      n: 2,
      title: 'Retry with exponential backoff',
      state: 'done',
      time: '6m 45s',
      summary: '2 edits · 1 command',
      items: [
        { k: 'edit', path: 'src/billing/webhooks.ts', add: 41, del: 12 },
        { k: 'edit', path: 'src/billing/retryWorker.ts', add: 19, del: 0, created: true },
        { k: 'cmd', cmd: 'pnpm db:generate', state: 'ok', exit: 0, time: '2.8s', out: ['✔ Generated migration 0042_webhook_attempts.sql'] }
      ]
    },
    {
      n: 3,
      title: 'Test the retry path',
      state: 'done',
      time: '4m 27s',
      summary: '1 edit · 2 commands',
      items: [
        { k: 'edit', path: 'tests/webhooks.test.ts', add: 12, del: 0 },
        {
          k: 'cmd',
          cmd: 'pnpm test --filter api -- webhooks',
          state: 'fail',
          exit: 1,
          time: '7.9s',
          out: [' ✗ tests/webhooks.test.ts > parks after 5 attempts', '   expected 0 to be 1']
        },
        { k: 'say', text: 'The worker counted attempts from zero. Fixed the off-by-one and ran everything.' },
        { k: 'cmd', cmd: 'pnpm test --filter api', state: 'ok', exit: 0, time: '12.4s', out: [' Test Files  9 passed (9)', '      Tests  71 passed (71)'] }
      ]
    }
  ],
  worked: '14m 22s',
  result: {
    text: 'Failed webhooks now retry at 1, 5, 25 and 125 minutes, then move to `webhook_dead_letters` with the last error. A worker picks up due retries every minute. Tests cover the backoff schedule and the dead-letter path; I did not cover two workers claiming the same event, so that check is still open.',
    receipt: '14m 22s · 212k tokens · $0.58 · GPT-5.6 Sol',
    files: [
      { path: 'src/db/migrations/0042_webhook_attempts.sql', add: 24, del: 0 },
      { path: 'src/billing/webhooks.ts', add: 41, del: 12 },
      { path: 'src/billing/retryWorker.ts', add: 19, del: 0 },
      { path: 'tests/webhooks.test.ts', add: 12, del: 0 }
    ]
  }
}

const PRICING: RecordData = {
  brief: 'Add a monthly / annual toggle to the pricing page. Annual saves 20%; show that on the toggle.',
  checks: [
    { text: 'The toggle switches every plan price', state: 'met', evidence: 'pricing.test.tsx › 3 plans' },
    { text: 'Matches the design at 800 and 1600px', state: 'met', evidence: 'Browser check · 2 screenshots' },
    { text: 'pnpm test passes', state: 'met', evidence: 'exit 0 · 128 tests' }
  ],
  steps: [
    {
      n: 1,
      title: 'Build the toggle',
      state: 'done',
      time: '5m 02s',
      summary: '2 edits · 3 lookups',
      items: [
        { k: 'look', verb: 'Read', obj: 'web/pricing/page.tsx' },
        { k: 'look', verb: 'Read', obj: 'web/pricing/plans.ts' },
        { k: 'look', verb: 'Searched', obj: 'useSearchParams' },
        { k: 'edit', path: 'web/pricing/BillingToggle.tsx', add: 62, del: 0, created: true },
        { k: 'edit', path: 'web/pricing/page.tsx', add: 38, del: 21 }
      ]
    },
    {
      n: 2,
      title: 'Check it in the browser',
      state: 'done',
      time: '3m 18s',
      summary: '2 screenshots',
      items: [
        { k: 'look', verb: 'Opened', obj: 'localhost:5173/pricing at 800px' },
        { k: 'look', verb: 'Opened', obj: 'localhost:5173/pricing at 1600px' },
        { k: 'say', text: 'Both widths match. At 800px the badge sits under the toggle, which the design allows.' }
      ]
    },
    {
      n: 3,
      title: 'Tests',
      state: 'done',
      time: '2m 40s',
      summary: '1 edit · 1 command',
      items: [
        { k: 'edit', path: 'web/pricing/pricing.test.tsx', add: 35, del: 0, created: true },
        { k: 'cmd', cmd: 'pnpm test', state: 'ok', exit: 0, time: '19.2s', out: [' Test Files  31 passed (31)', '      Tests  128 passed (128)'] }
      ]
    }
  ],
  worked: '11m 00s',
  result: {
    text: 'The toggle sits above the plans and keeps the choice in the URL (`?billing=annual`), so links carry it. Prices animate between the two amounts; the badge reads “Save 20%”.',
    receipt: '11m 00s · 164k tokens · $0.44 · Opus 5.5',
    files: [
      { path: 'web/pricing/BillingToggle.tsx', add: 62, del: 0 },
      { path: 'web/pricing/page.tsx', add: 38, del: 21 },
      { path: 'web/pricing/pricing.test.tsx', add: 35, del: 0 }
    ]
  }
}

const BUMP_ZOD: RecordData = {
  brief: 'Bump zod to 4.2 and fix whatever breaks.',
  checks: [
    { text: 'Typecheck passes', state: 'met', evidence: 'tsc exit 0' },
    { text: 'pnpm test passes', state: 'met', evidence: 'exit 0 · 214 tests' }
  ],
  steps: [
    {
      n: 1,
      title: 'Bump and install',
      state: 'done',
      time: '0m 48s',
      summary: '1 edit',
      items: [{ k: 'edit', path: 'package.json', add: 1, del: 1 }]
    },
    {
      n: 2,
      title: 'Fix the two breaking call sites',
      state: 'done',
      time: '1m 30s',
      summary: '1 edit · 1 lookup',
      items: [
        { k: 'look', verb: 'Searched', obj: '.nonstrict()' },
        { k: 'edit', path: 'src/lib/validate.ts', add: 2, del: 2 }
      ]
    },
    {
      n: 3,
      title: 'Typecheck and test',
      state: 'done',
      time: '2m 33s',
      summary: '2 commands',
      items: [
        { k: 'cmd', cmd: 'pnpm tsc --noEmit', state: 'ok', exit: 0, time: '9.8s', out: [] },
        { k: 'cmd', cmd: 'pnpm test', state: 'ok', exit: 0, time: '41.0s', out: ['      Tests  214 passed (214)'] }
      ]
    }
  ],
  worked: '4m 51s',
  result: {
    text: 'zod 4.2 renamed `.nonstrict()` to `.loose()`; two schemas in `src/lib/validate.ts` used it. Everything else compiled unchanged.',
    receipt: '4m 51s · 61k tokens · $0.00 · Qwen3 Coder (local)',
    files: [
      { path: 'package.json', add: 1, del: 1 },
      { path: 'pnpm-lock.yaml', add: 24, del: 24 },
      { path: 'src/lib/validate.ts', add: 2, del: 2 }
    ]
  }
}

const SEARCH_CACHE: RecordData = {
  brief: 'Cache repository search results in Redis for 60 seconds, keyed by query and repo.',
  checks: [
    { text: 'A second identical search is served from the cache', state: 'open' },
    { text: 'pnpm test passes', state: 'unmet', evidence: 'exit 1 · redis connection refused' }
  ],
  steps: [
    {
      n: 1,
      title: 'Add the cache wrapper',
      state: 'done',
      time: '3m 02s',
      summary: '2 edits · 2 lookups',
      items: [
        { k: 'look', verb: 'Read', obj: 'src/search/index.ts' },
        { k: 'look', verb: 'Read', obj: 'src/lib/redis.ts' },
        { k: 'edit', path: 'src/search/cache.ts', add: 34, del: 0, created: true },
        { k: 'edit', path: 'src/search/index.ts', add: 3, del: 1 }
      ]
    },
    {
      n: 2,
      title: 'Test it against Redis',
      state: 'failed',
      time: '0m 41s',
      items: [
        {
          k: 'cmd',
          cmd: 'pnpm test --filter api -- search',
          state: 'fail',
          exit: 1,
          time: '6.3s',
          out: [' ✗ tests/search.test.ts > serves a repeat query from the cache', '   Error: connect ECONNREFUSED 127.0.0.1:6379']
        },
        {
          k: 'error',
          title: 'Redis refused the connection',
          detail: 'The tests need Redis on 127.0.0.1:6379 and nothing is listening. Start it with `docker compose up redis` and retry, or ask it to mock Redis in the tests.'
        }
      ]
    },
    { n: 3, title: 'Measure the hit rate', state: 'queued', items: [] }
  ]
}

const OPENAPI: RecordData = {
  brief: 'Write OpenAPI docs for every /v1/users endpoint from the handlers, not from memory.',
  checks: [{ text: 'The spec validates', state: 'met', evidence: 'redocly lint · 0 problems' }],
  steps: [
    {
      n: 1,
      title: 'Read the handlers',
      state: 'done',
      time: '1m 12s',
      summary: '2 lookups',
      items: [
        { k: 'look', verb: 'Read', obj: 'src/routes/users.ts' },
        { k: 'look', verb: 'Read', obj: 'src/lib/validate.ts' }
      ]
    },
    {
      n: 2,
      title: 'Write the spec',
      state: 'done',
      time: '3m 40s',
      summary: '2 edits',
      items: [
        { k: 'edit', path: 'docs/openapi/users.yaml', add: 212, del: 0, created: true },
        { k: 'edit', path: 'docs/openapi/index.yaml', add: 3, del: 0 }
      ]
    },
    {
      n: 3,
      title: 'Validate it',
      state: 'done',
      time: '0m 22s',
      summary: '1 command',
      items: [{ k: 'cmd', cmd: 'pnpm redocly lint docs/openapi/index.yaml', state: 'ok', exit: 0, time: '2.2s', out: ['Your API description is valid.'] }]
    }
  ],
  worked: '5m 14s',
  result: {
    text: 'Seven endpoints, each with request and response schemas taken from the zod validators and every error the handlers can return.',
    receipt: '5m 14s · 88k tokens · $0.12 · Fable 5.1',
    files: [
      { path: 'docs/openapi/users.yaml', add: 212, del: 0 },
      { path: 'docs/openapi/index.yaml', add: 3, del: 0 }
    ]
  }
}

const LEGACY: RecordData = {
  brief: 'Remove the legacy auth middleware now that every route uses requireUser.',
  checks: [{ text: 'No file imports legacyAuth', state: 'open' }],
  steps: [
    {
      n: 1,
      title: 'Find every use of legacyAuth',
      state: 'done',
      time: '0m 58s',
      summary: '2 lookups',
      items: [
        { k: 'look', verb: 'Searched', obj: 'legacyAuth' },
        { k: 'look', verb: 'Searched', obj: 'req.legacyUser' }
      ]
    },
    {
      n: 2,
      title: 'Remove it route by route',
      state: 'stopped',
      time: '1m 20s',
      items: [
        { k: 'edit', path: 'src/routes/admin.ts', add: 1, del: 6 },
        { k: 'say', text: '`admin.ts` still reads `req.legacyUser` in two places. Replacing those with' }
      ]
    },
    { n: 3, title: 'Delete the middleware', state: 'queued', items: [] }
  ]
}

const IOS: RecordData = {
  brief: 'After Sign in with Apple on iOS the app lands on a blank screen instead of Home. Fix the redirect.',
  checks: [{ text: 'Signing in lands on Home on iOS 19 and 18', state: 'open' }],
  steps: [
    {
      n: 1,
      title: 'Reproduce in the simulator',
      state: 'done',
      time: '2m 11s',
      summary: '1 command · 1 lookup',
      items: [{ k: 'look', verb: 'Read', obj: 'app/auth/callback.tsx' }]
    },
    {
      n: 2,
      title: 'Fix the callback route',
      state: 'running',
      time: '0m 52s',
      items: [
        { k: 'say', text: 'The callback replaces the route before the session is stored, so Home mounts signed out and renders nothing.' },
        { k: 'edit', path: 'app/auth/callback.tsx', add: 9, del: 3 },
        { k: 'live', text: 'Rebuilding for the simulator' }
      ]
    },
    { n: 3, title: 'Test on iOS 19 and 18', state: 'queued', items: [] }
  ]
}

const BADGES: RecordData = {
  brief: 'Show the unread count as the app icon badge, and clear it when the app opens.',
  checks: [
    { text: 'The badge matches the unread count', state: 'met', evidence: 'badge.test.ts › 4 cases' },
    { text: 'Opening the app clears it', state: 'met', evidence: 'Simulator check · iOS 19' }
  ],
  steps: [
    {
      n: 1,
      title: 'Set the badge from push payloads',
      state: 'done',
      time: '3m 40s',
      summary: '1 edit',
      items: [{ k: 'edit', path: 'app/notifications/badge.ts', add: 22, del: 0, created: true }]
    },
    { n: 2, title: 'Clear it on open', state: 'done', time: '1m 55s', summary: '1 edit', items: [{ k: 'edit', path: 'app/App.tsx', add: 9, del: 4 }] }
  ],
  worked: '8m 02s',
  result: {
    text: 'Push payloads carry `unread`, and the badge follows it. Opening the app clears the badge once the inbox has loaded, so a cold start never flashes zero.',
    receipt: '8m 02s · 97k tokens · $0.22 · Opus 5.5',
    files: [
      { path: 'app/notifications/badge.ts', add: 22, del: 0 },
      { path: 'app/App.tsx', add: 9, del: 4 }
    ]
  }
}

const ICONS: RecordData = {
  brief: 'Regenerate the app icons from the new logo at every size iOS and Android need.',
  checks: [{ text: 'Every size listed in app.json exists', state: 'met', evidence: '14 of 14' }],
  steps: [{ n: 1, title: 'Export and replace', state: 'done', time: '2m 20s', summary: '14 edits · 1 command', items: [] }],
  worked: '2m 20s',
  result: { text: 'All 14 icon sizes regenerated from `logo.svg`.', receipt: '2m 20s · 12k tokens · $0.03 · Fable 5.1', files: [] }
}

export const RECORDS: Record<string, RecordData> = {
  'rate-limits': RATE_LIMITS,
  'migrate-sessions': MIGRATE,
  'plan-billing': BILLING_PLAN,
  'audit-auth': AUDIT,
  'flaky-checkout': FLAKY,
  'webhook-retry': WEBHOOK_RETRY,
  'pricing-toggle': PRICING,
  'bump-zod': BUMP_ZOD,
  'search-cache': SEARCH_CACHE,
  'openapi-users': OPENAPI,
  'legacy-auth': LEGACY,
  'ios-redirect': IOS,
  'push-badges': BADGES,
  'app-icons': ICONS
}

/* ─── Diffs ────────────────────────────────────────────────────────────────── */

export type DiffLine = { t: ' ' | '+' | '-' | '@'; a?: number; b?: number; s: string }
export type FileDiff = { path: string; add: number; del: number; status: 'A' | 'M' | 'D'; lines: DiffLine[] }

const added = (rows: string[]): DiffLine[] => rows.map((s, i) => ({ t: '+', b: i + 1, s }))

export const DIFFS: Record<string, FileDiff[]> = {
  'rate-limits': [
    {
      path: 'src/middleware/rateLimit.ts',
      add: 58,
      del: 0,
      status: 'A',
      lines: [
        { t: '@', s: '@@ -0,0 +1,58 @@' },
        ...added([
          "import type { Request, Response, NextFunction } from 'express'",
          "import { redis } from '../lib/redis'",
          '',
          'const WINDOW_MS = 60_000',
          'const LIMIT_KEY = 100',
          'const LIMIT_IP = 20',
          '',
          'export async function rateLimit(req: Request, res: Response, next: NextFunction) {',
          "  const key = req.header('x-api-key')",
          '  const id = key ? `key:${key}` : `ip:${req.ip}`',
          '  const limit = key ? LIMIT_KEY : LIMIT_IP',
          '  const now = Date.now()',
          '',
          '  const [, , count] = await redis',
          '    .multi()',
          '    .zremrangebyscore(id, 0, now - WINDOW_MS)',
          '    .zadd(id, now, `${now}`)',
          '    .zcard(id)',
          '    .exec()'
        ])
      ]
    },
    {
      path: 'src/routes/public/index.ts',
      add: 6,
      del: 7,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -1,14 +1,13 @@ export const publicRouter' },
        { t: ' ', a: 1, b: 1, s: "import { Router } from 'express'" },
        { t: '-', a: 2, s: "import { throttle } from '../../lib/throttle'" },
        { t: '+', b: 2, s: "import { rateLimit } from '../../middleware/rateLimit'" },
        { t: ' ', a: 3, b: 3, s: "import { search } from './search'" },
        { t: ' ', a: 4, b: 4, s: "import { status } from './status'" },
        { t: ' ', a: 5, b: 5, s: '' },
        { t: ' ', a: 6, b: 6, s: 'export const publicRouter = Router()' },
        { t: '-', a: 7, s: '' },
        { t: '-', a: 8, s: '// TODO: real limits' },
        { t: '-', a: 9, s: 'publicRouter.use(throttle({ perSecond: 50 }))' },
        { t: '+', b: 7, s: 'publicRouter.use(rateLimit)' },
        { t: ' ', a: 10, b: 8, s: "publicRouter.get('/status', status)" },
        { t: ' ', a: 11, b: 9, s: "publicRouter.get('/search', search)" }
      ]
    }
  ],
  'migrate-sessions': [
    {
      path: 'src/db/schema.ts',
      add: 18,
      del: 0,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -88,3 +88,21 @@' },
        { t: ' ', a: 88, b: 88, s: '})' },
        { t: ' ', a: 89, b: 89, s: '' },
        { t: '+', b: 90, s: "export const sessions = pgTable('sessions', {" },
        { t: '+', b: 91, s: "  id: text('id').primaryKey()," },
        { t: '+', b: 92, s: "  userId: uuid('user_id').notNull()," },
        { t: '+', b: 93, s: "  expiresAt: timestamp('expires_at').notNull()" },
        { t: '+', b: 94, s: '})' }
      ]
    },
    {
      path: 'src/auth/sessionStore.ts',
      add: 51,
      del: 10,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -4,12 +4,18 @@ export const sessionStore' },
        { t: ' ', a: 4, b: 4, s: 'export const sessionStore = {' },
        { t: '-', a: 5, s: '  async set(id: string, s: Session) {' },
        { t: '-', a: 6, s: '    await redis.set(`sess:${id}`, JSON.stringify(s))' },
        { t: '+', b: 5, s: '  async set(id: string, s: Session) {' },
        { t: '+', b: 6, s: '    // Dual-write until reads move to Postgres (step 4).' },
        { t: '+', b: 7, s: '    await Promise.all([redis.set(`sess:${id}`, JSON.stringify(s)), db.insert(sessions).values(row(id, s))])' },
        { t: ' ', a: 7, b: 8, s: '  },' }
      ]
    }
  ],
  'plan-billing': [
    {
      path: 'plans/usage-billing.md',
      add: 68,
      del: 0,
      status: 'A',
      lines: [
        { t: '@', s: '@@ -0,0 +1,68 @@' },
        ...added([
          '# Usage-based billing',
          '',
          'Meter every authenticated request, roll usage up nightly,',
          'and report it to Stripe so each invoice carries the overage.',
          '',
          '## Adds',
          '',
          '- `usage_events` — one row per request',
          '- `usage_daily` — nightly rollup the invoice reads'
        ])
      ]
    }
  ],
  'webhook-retry': [
    {
      path: 'src/db/migrations/0042_webhook_attempts.sql',
      add: 24,
      del: 0,
      status: 'A',
      lines: [
        { t: '@', s: '@@ -0,0 +1,24 @@' },
        ...added(['CREATE TABLE webhook_attempts (', '  id          bigserial PRIMARY KEY,', '  event_id    text NOT NULL,', '  n           int  NOT NULL,', '  retry_at    timestamptz,', '  last_error  text', ');'])
      ]
    },
    {
      path: 'src/billing/webhooks.ts',
      add: 41,
      del: 12,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -18,20 +18,31 @@ export async function handleStripeEvent' },
        { t: ' ', a: 18, b: 18, s: 'export async function handleStripeEvent(event: Stripe.Event) {' },
        { t: '-', a: 19, s: '  try {' },
        { t: '-', a: 20, s: '    await dispatch(event)' },
        { t: '-', a: 21, s: '  } catch (err) {' },
        { t: '-', a: 22, s: "    log.error('webhook failed', err)" },
        { t: '-', a: 23, s: '  }' },
        { t: '+', b: 19, s: '  const attempt = await attempts.begin(event.id)' },
        { t: '+', b: 20, s: '  try {' },
        { t: '+', b: 21, s: '    await dispatch(event)' },
        { t: '+', b: 22, s: '    await attempts.succeed(attempt)' },
        { t: '+', b: 23, s: '  } catch (err) {' },
        { t: '+', b: 24, s: '    if (attempt.n >= MAX_ATTEMPTS) return deadLetter(event, err)' },
        { t: '+', b: 25, s: '    await attempts.retryAt(attempt, backoff(attempt.n))' },
        { t: '+', b: 26, s: '  }' },
        { t: ' ', a: 24, b: 27, s: '}' },
        { t: ' ', a: 25, b: 28, s: '' },
        { t: '+', b: 29, s: '/** 1, 5, 25, 125 minutes. */' },
        { t: '+', b: 30, s: 'export const backoff = (n: number) => 60_000 * 5 ** (n - 1)' }
      ]
    },
    {
      path: 'src/billing/retryWorker.ts',
      add: 19,
      del: 0,
      status: 'A',
      lines: [
        { t: '@', s: '@@ -0,0 +1,19 @@' },
        ...added([
          "import { attempts } from './attempts'",
          "import { handleStripeEvent } from './webhooks'",
          '',
          '/** Picks up due retries once a minute. */',
          'export function startRetryWorker() {',
          '  return setInterval(async () => {',
          '    for (const due of await attempts.due(new Date())) {',
          '      await handleStripeEvent(due.event)',
          '    }',
          '  }, 60_000)',
          '}'
        ])
      ]
    },
    {
      path: 'tests/webhooks.test.ts',
      add: 12,
      del: 0,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -40,3 +40,15 @@' },
        { t: ' ', a: 40, b: 40, s: '})' },
        { t: ' ', a: 41, b: 41, s: '' },
        { t: '+', b: 42, s: "test('parks after 5 attempts', async () => {" },
        { t: '+', b: 43, s: '  const event = fakeEvent()' },
        { t: '+', b: 44, s: '  for (let i = 0; i < 5; i++) await handleStripeEvent(event)' },
        { t: '+', b: 45, s: '  expect(await deadLetters.count()).toBe(1)' },
        { t: '+', b: 46, s: '})' }
      ]
    }
  ],
  'pricing-toggle': [
    {
      path: 'web/pricing/BillingToggle.tsx',
      add: 62,
      del: 0,
      status: 'A',
      lines: [
        { t: '@', s: '@@ -0,0 +1,62 @@' },
        ...added([
          "import { useSearchParams } from 'next/navigation'",
          '',
          "export type Billing = 'monthly' | 'annual'",
          '',
          '/** Monthly or annual, kept in the URL so links carry it. */',
          'export function BillingToggle() {',
          '  const [params] = useSearchParams()',
          "  const billing = (params.get('billing') ?? 'monthly') as Billing",
          '  return (',
          '    <div role="radiogroup" aria-label="Billing period">',
          "      <Option value=\"monthly\" on={billing === 'monthly'} />",
          "      <Option value=\"annual\" on={billing === 'annual'} />",
          '      <span className="badge">Save 20%</span>',
          '    </div>',
          '  )',
          '}'
        ])
      ]
    },
    {
      path: 'web/pricing/page.tsx',
      add: 38,
      del: 21,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -12,9 +12,12 @@ export default function Pricing' },
        { t: ' ', a: 12, b: 12, s: '  return (' },
        { t: ' ', a: 13, b: 13, s: '    <main className="pricing">' },
        { t: ' ', a: 14, b: 14, s: '      <h1>Simple pricing for every API</h1>' },
        { t: '+', b: 15, s: '      <BillingToggle />' },
        { t: '-', a: 15, s: '      <Plans prices={MONTHLY} />' },
        { t: '+', b: 16, s: "      <Plans prices={billing === 'annual' ? ANNUAL : MONTHLY} />" },
        { t: ' ', a: 16, b: 17, s: '    </main>' },
        { t: ' ', a: 17, b: 18, s: '  )' }
      ]
    },
    {
      path: 'web/pricing/pricing.test.tsx',
      add: 35,
      del: 0,
      status: 'A',
      lines: [
        { t: '@', s: '@@ -0,0 +1,35 @@' },
        ...added([
          "test('annual switches every plan price', async () => {",
          "  render(<Pricing searchParams={{ billing: 'annual' }} />)",
          "  expect(screen.getByText('$24')).toBeVisible()",
          '})'
        ])
      ]
    }
  ],
  'bump-zod': [
    {
      path: 'package.json',
      add: 1,
      del: 1,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -31,7 +31,7 @@ "dependencies"' },
        { t: ' ', a: 31, b: 31, s: '    "stripe": "^19.2.0",' },
        { t: '-', a: 32, s: '    "zod": "^4.1.12"' },
        { t: '+', b: 32, s: '    "zod": "^4.2.0"' },
        { t: ' ', a: 33, b: 33, s: '  },' }
      ]
    },
    {
      path: 'pnpm-lock.yaml',
      add: 24,
      del: 24,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -2210,6 +2210,6 @@' },
        { t: '-', a: 2210, s: '  zod@4.1.12:' },
        { t: '-', a: 2211, s: '    resolution: {integrity: sha512-9Jx…}' },
        { t: '+', b: 2210, s: '  zod@4.2.0:' },
        { t: '+', b: 2211, s: '    resolution: {integrity: sha512-Qa4…}' }
      ]
    },
    {
      path: 'src/lib/validate.ts',
      add: 2,
      del: 2,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -14,4 +14,4 @@' },
        { t: '-', a: 14, s: 'export const Metadata = z.object({}).nonstrict()' },
        { t: '-', a: 15, s: 'export const Headers = z.record(z.string()).nonstrict()' },
        { t: '+', b: 14, s: 'export const Metadata = z.object({}).loose()' },
        { t: '+', b: 15, s: 'export const Headers = z.record(z.string()).loose()' }
      ]
    }
  ],
  'search-cache': [
    {
      path: 'src/search/cache.ts',
      add: 34,
      del: 0,
      status: 'A',
      lines: [
        { t: '@', s: '@@ -0,0 +1,34 @@' },
        ...added([
          "import { redis } from '../lib/redis'",
          '',
          'const TTL_S = 60',
          '',
          '/** Search results for one repo and query, cached for a minute. */',
          'export async function cached<T>(repo: string, q: string, run: () => Promise<T>): Promise<T> {',
          '  const key = `search:${repo}:${q}`',
          '  const hit = await redis.get(key)',
          '  if (hit) return JSON.parse(hit) as T',
          '  const value = await run()',
          "  await redis.set(key, JSON.stringify(value), 'EX', TTL_S)",
          '  return value',
          '}'
        ])
      ]
    },
    {
      path: 'src/search/index.ts',
      add: 3,
      del: 1,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -9,4 +9,6 @@' },
        { t: '-', a: 9, s: 'export const search = (repo: string, q: string) => runSearch(repo, q)' },
        { t: '+', b: 9, s: "import { cached } from './cache'" },
        { t: '+', b: 10, s: '' },
        { t: '+', b: 11, s: 'export const search = (repo: string, q: string) => cached(repo, q, () => runSearch(repo, q))' }
      ]
    }
  ],
  'openapi-users': [
    {
      path: 'docs/openapi/users.yaml',
      add: 212,
      del: 0,
      status: 'A',
      lines: [{ t: '@', s: '@@ -0,0 +1,212 @@' }, ...added(['paths:', '  /v1/users:', '    get:', '      summary: List users', '      parameters:', '        - $ref: "#/components/parameters/Cursor"'])]
    },
    {
      path: 'docs/openapi/index.yaml',
      add: 3,
      del: 0,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -6,2 +6,5 @@' },
        { t: ' ', a: 6, b: 6, s: 'paths:' },
        { t: '+', b: 7, s: '  /v1/users:' },
        { t: '+', b: 8, s: '    $ref: "./users.yaml#/paths/~1v1~1users"' },
        { t: '+', b: 9, s: '' }
      ]
    }
  ],
  'legacy-auth': [
    {
      path: 'src/routes/admin.ts',
      add: 1,
      del: 6,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -1,9 +1,4 @@' },
        { t: '-', a: 1, s: "import { legacyAuth } from '../middleware/legacyAuth'" },
        { t: '+', b: 1, s: "import { requireUser } from '../middleware/auth'" },
        { t: ' ', a: 2, b: 2, s: '' },
        { t: '-', a: 3, s: 'adminRouter.use(legacyAuth)' },
        { t: '-', a: 4, s: 'adminRouter.use((req, _res, next) => {' },
        { t: '-', a: 5, s: '  req.user = req.legacyUser' },
        { t: '-', a: 6, s: '  next()' },
        { t: '-', a: 7, s: '})' }
      ]
    }
  ],
  'ios-redirect': [
    {
      path: 'app/auth/callback.tsx',
      add: 9,
      del: 3,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -18,7 +18,13 @@ export default function Callback' },
        { t: ' ', a: 18, b: 18, s: '  useEffect(() => {' },
        { t: '-', a: 19, s: "    router.replace('/home')" },
        { t: '-', a: 20, s: '    storeSession(params.session)' },
        { t: '+', b: 19, s: '    // Store first: Home reads the session as it mounts.' },
        { t: '+', b: 20, s: '    storeSession(params.session).then(() => {' },
        { t: '+', b: 21, s: "      router.replace('/home')" },
        { t: '+', b: 22, s: '    })' },
        { t: ' ', a: 21, b: 23, s: '  }, [params.session])' }
      ]
    }
  ],
  'push-badges': [
    {
      path: 'app/notifications/badge.ts',
      add: 22,
      del: 0,
      status: 'A',
      lines: [
        { t: '@', s: '@@ -0,0 +1,22 @@' },
        ...added([
          "import * as Notifications from 'expo-notifications'",
          '',
          '/** The icon badge follows the unread count the push carries. */',
          'export async function syncBadge(unread: number) {',
          '  await Notifications.setBadgeCountAsync(Math.max(0, unread))',
          '}'
        ])
      ]
    },
    {
      path: 'app/App.tsx',
      add: 9,
      del: 4,
      status: 'M',
      lines: [
        { t: '@', s: '@@ -30,6 +30,11 @@ export default function App' },
        { t: ' ', a: 30, b: 30, s: '  const inbox = useInbox()' },
        { t: '-', a: 31, s: '  useEffect(() => {}, [])' },
        { t: '+', b: 31, s: '  useEffect(() => {' },
        { t: '+', b: 32, s: '    // Clear once the inbox has loaded, so a cold start never flashes 0.' },
        { t: '+', b: 33, s: '    if (inbox.loaded) syncBadge(0)' },
        { t: '+', b: 34, s: '  }, [inbox.loaded])' }
      ]
    }
  ]
}

/** How many files a task changed: the count Keep, Undo and Commit act on. */
export const filesChanged = (id: string): number => (DIFFS[id] ?? []).length

/* ─── Terminal ─────────────────────────────────────────────────────────────── */

export type TermRun = { cmd: string; exit?: number; time: string; out: string[] }

/** Commands a task ran outside its record's steps (setup, installs). The record's own commands follow. */
export const TERMINAL_BEFORE: Record<string, TermRun[]> = {
  'rate-limits': [{ cmd: 'pnpm tsc --noEmit -p .', exit: 0, time: '6.2s', out: [] }],
  'bump-zod': [{ cmd: 'pnpm add zod@4.2.0', exit: 0, time: '4.4s', out: ['+ zod 4.2.0', 'Done in 4.3s'] }],
  'ios-redirect': [{ cmd: 'pnpm ios --simulator "iPhone 17"', exit: 0, time: '48.1s', out: ['› Opening on iPhone 17 (iOS 19.0)'] }]
}

/* ─── Files ────────────────────────────────────────────────────────────────── */

/** The repo's files the tree always shows; a task's changed files are merged in. */
export const REPO_FILES: Record<string, string[]> = {
  acme: [
    'src/server.ts',
    'src/lib/redis.ts',
    'src/lib/validate.ts',
    'src/middleware/auth.ts',
    'src/routes/public/index.ts',
    'src/routes/public/search.ts',
    'src/routes/public/status.ts',
    'src/routes/users.ts',
    'src/routes/admin.ts',
    'src/billing/stripe.ts',
    'src/billing/webhooks.ts',
    'src/db/schema.ts',
    'src/search/index.ts',
    'tests/public.test.ts',
    'tests/webhooks.test.ts',
    'web/pricing/page.tsx',
    'web/e2e/checkout.spec.ts',
    'package.json',
    'tsconfig.json'
  ],
  'acme-mobile': ['app/App.tsx', 'app/auth/callback.tsx', 'app/notifications/index.ts', 'app.json', 'package.json']
}

/* ─── Commit messages, drafted when Review opens ───────────────────────────── */

export const COMMIT_DRAFTS: Record<string, { title: string; body: string }> = {
  'webhook-retry': {
    title: 'Retry failed Stripe webhooks with backoff',
    body: 'Failed events retry at 1, 5, 25 and 125 minutes, then park in\nwebhook_dead_letters with the last error. A worker picks up due\nretries every minute.'
  },
  'pricing-toggle': { title: 'Pricing: monthly / annual toggle with a saved-percent badge', body: 'The choice lives in ?billing=, so links keep it.' },
  'push-badges': { title: 'Badge count on push notifications', body: 'The badge follows the unread count and clears once the inbox loads.' },
  'rate-limits': { title: 'Rate-limit public routes', body: '100 requests a minute per API key, 20 per IP without one.\n429s carry Retry-After.' },
  'search-cache': { title: 'Cache repository search results for 60s', body: 'Keyed by repo and query in Redis.' },
  'legacy-auth': { title: 'Move admin routes to requireUser', body: 'First step of removing the legacy auth middleware.' },
  'openapi-users': { title: 'OpenAPI docs for /v1/users', body: 'Seven endpoints, schemas from the zod validators.' }
}

/* ─── Models ───────────────────────────────────────────────────────────────── */

export const MODELS = [
  { id: 'auto', name: 'Auto', note: 'Picks per step' },
  { id: 'opus', name: 'Opus 5.5', note: '1M context' },
  { id: 'fable', name: 'Fable 5.1', note: 'Fast' },
  { id: 'sol', name: 'GPT-5.6 Sol', note: '400k context' },
  { id: 'gemini', name: 'Gemini 3.1 Pro', note: '2M context' },
  { id: 'qwen', name: 'Qwen3 Coder', note: 'Ollama · local' }
] as const

export const EFFORTS = ['Low', 'Medium', 'High', 'Max'] as const
export type Effort = (typeof EFFORTS)[number]

/* ─── Composer menus ───────────────────────────────────────────────────────── */

/** Skills that answer to a slash command. Sample names; the real list comes from installed skills. */
export const SLASH = [
  { cmd: '/review', what: 'Review the changes against the checks' },
  { cmd: '/test', what: 'Run the tests and fix what fails' },
  { cmd: '/changelog', what: 'Write a changelog entry for the kept changes' },
  { cmd: '/explain', what: 'Explain a file or a selection, change nothing' }
] as const

/* ─── Extensions ───────────────────────────────────────────────────────────── */

export type Extension = {
  id: string
  kind: 'mcp' | 'skill' | 'rule'
  name: string
  what: string
  state: 'on' | 'off' | 'signin'
  meta: string
}

export const EXTENSIONS: Extension[] = [
  { id: 'github', kind: 'mcp', name: 'GitHub', what: 'Issues, pull requests and checks', state: 'on', meta: '26 tools' },
  { id: 'linear', kind: 'mcp', name: 'Linear', what: 'Read and update issues', state: 'on', meta: '12 tools' },
  { id: 'sentry', kind: 'mcp', name: 'Sentry', what: 'Errors and traces for a release', state: 'signin', meta: 'Needs sign-in' },
  { id: 'postgres', kind: 'mcp', name: 'Postgres', what: 'Read-only queries on the dev database', state: 'off', meta: '4 tools · local' },
  { id: 'frontend', kind: 'skill', name: 'Frontend design', what: 'Layouts, type and colour that are not generic', state: 'on', meta: 'Bundled' },
  { id: 'pdf', kind: 'skill', name: 'PDF', what: 'Read, fill and merge PDFs', state: 'on', meta: 'Bundled' },
  { id: 'changelog', kind: 'skill', name: 'Changelog', what: 'Answers to /changelog', state: 'on', meta: '~/.vyotiq/skills' },
  { id: 'pnpm', kind: 'rule', name: 'Use pnpm, never npm', what: 'Every task', state: 'on', meta: 'AGENTS.md' },
  { id: 'tests-near', kind: 'rule', name: 'Tests live next to the code', what: 'src/**', state: 'on', meta: '.vyotiq/rules' },
  { id: 'no-default', kind: 'rule', name: 'No default exports', what: '**/*.ts', state: 'on', meta: '.vyotiq/rules' }
]

/* ─── Usage ────────────────────────────────────────────────────────────────── */

/** Tokens in thousands. */
export const USAGE_DAYS: { day: string; tasks: number; tokens: number; cost: number }[] = [
  { day: 'Mon 22', tasks: 3, tokens: 410, cost: 0.92 },
  { day: 'Tue 23', tasks: 5, tokens: 780, cost: 1.64 },
  { day: 'Wed 24', tasks: 2, tokens: 260, cost: 0.51 },
  { day: 'Thu 25', tasks: 0, tokens: 0, cost: 0 },
  { day: 'Fri 26', tasks: 4, tokens: 620, cost: 1.33 },
  { day: 'Sat 27', tasks: 1, tokens: 90, cost: 0.14 },
  { day: 'Sun 28', tasks: 0, tokens: 0, cost: 0 },
  { day: 'Mon 29', tasks: 6, tokens: 1120, cost: 2.41 },
  { day: 'Tue 30', tasks: 8, tokens: 1290, cost: 2.45 }
]

export const MODEL_MIX = [
  { name: 'Opus 5.5', share: 0.58 },
  { name: 'GPT-5.6 Sol', share: 0.24 },
  { name: 'Fable 5.1', share: 0.12 },
  { name: 'Qwen3 Coder', share: 0.06 }
] as const

export const TOOL_FAILURES = [
  { tool: 'terminal', why: 'exit 1 — tests failing', n: 9 },
  { tool: 'browser', why: 'timeout waiting for the page', n: 2 },
  { tool: 'edit', why: 'the file changed since it was read', n: 1 }
] as const
