# Threads: three directions for the list, the thread and the composer

These mockups compare three ways to rebuild the task thread. The current
record has four problems: the answer is hard to find, the thread is too
noisy, it doesn't feel like a conversation, and it looks dated. Each
direction covers the thread list, the thread itself and the composer. All
three render the same threads, so the comparison is about design, not data.

They are built on the renderer's own stack: the real `--vy-*` tokens in all
5 skins × light/dark, the real primitives from `lib/ui` and icons from
`lib/icons`.

```sh
pnpm redesign:threads      # http://localhost:5211
```

`?d=<a|b|c>&scene=<rate|flaky|dark|build|oauth|new>&skin=<skin>&theme=<light|dark>&size=<1024|1280|1440|1920>&bare=1`

## Directions

| | Thread | List | Work |
| --- | --- | --- | --- |
| **A · Conversation** | Your message on the right, its reply below. One line, "Worked for 3m 23s · 4 files read · 1 command · 4 edits", stands above the answer | By recency (Needs you pinned first). The second line shows what each thread is doing or left behind | Folded into that one line. It opens while the run works and folds itself the moment the run settles |
| **B · Outcome first** | Your ask is the heading, then one status line, then the answer, then what changed and the checks side by side. Earlier turns collapse to one line each | Grouped by status (Needs you, Working, Ready for review, Didn't finish, Done). The glyph sits once on the group heading | "Progress" while live, with the plan as a hairline under the header. Afterwards it folds into "How it got there" |
| **C · Conversation + work** | Only the conversation, with file chips and checks under each reply | One line per thread, grouped by workspace, with a glyph column | A right pane (Work, Changes, Terminal) for whichever reply's chip you pick |

## A+ · Conversation, refined (the pick)

`?d=aplus` (the default). A's structure, rebuilt in `aplus/`:

- **Order.** Each reply goes: your message → one work line → anything it needs from you → the answer → files changed and checks → footer. Nothing below the answer appears until the answer has finished streaming.
- **Streaming.** Text arrives in bursts, the way model tokens do, and the reply drains whatever has arrived over a quarter second (`stream.ts`). Big bursts speed the reveal up, lulls let it catch up, and every cut lands on a word boundary. The store and the view read the same clock (`streamStart`), so switching threads never restarts the text. Finished blocks are memoised; only the block being written is re-parsed, and only that block is made safe to read mid-sentence (`blocks.ts`): a half link shows its words, an open `**` closes, a table waits for its delimiter row, and an opener with nothing after it waits. Stopping keeps the words that had arrived.
- **Answers** are rendered by the app's own reply renderer, `src/renderer/src/features/task/record/reply/` (`ReplyMarkdown`, `reply.css`), imported rather than copied, so the mockup and the record cannot drift. `markdown.tsx` only adapts it: here a path opens only when the thread knows the file. The parser is the app's (react-markdown + GFM + GitHub's sanitize schema). The type and spacing come from measuring ChatGPT, Claude, Gemini, Cursor and Copilot:
  - **Type and spacing:** 14px on a 24px line, at most 72 characters wide. Headings at 18/15/14/13px, with more room above than below. One 14px gap between blocks. Links keep a faint underline.
  - **File chips:** every workspace path becomes a chip, as in the app; here only one the thread read or changed opens, in code (`src/a.ts:42`, `./a.ts`, `a.ts#L9`) or as a link (`[the check](src/a.ts#L42)`). Files changed so far open in Review, even mid-stream; in the app, any workspace path opens in Files at its line. A short name opens only when it matches one file.
  - **Code cards:** a 32px head that names a file and its lines (`ts src/a.ts:58-63`, numbered from 58) or a language, with Wrap and Copy. Long blocks fold at 20 lines. Code is coloured from the app's own `--vy-syntax-*` tokens, so every skin follows, and it is coloured line by line while it streams.
  - **Shell cards:** Copy leaves out the `$` prompts and the output.
  - **Diff cards:** a + / − gutter and a +N −N head.
  - **Diagrams and charts:** Mermaid diagrams and the app's `chart` fences, drawn in token colours once the fence closes, with a Source / Data toggle.
  - **Tables:** rules between rows, numbers right-aligned (a dash or N/A in a cell does not break that), Copy as Markdown (as written, alignment and code kept) or CSV.
  - **Smaller elements:** GitHub alerts (`> [!WARNING]`) with an icon and a word, task lists with the app's check mark, `<details>` folds, `<kbd>` keys, footnotes that scroll within the answer, and images that load only if the app made them.
  - **Left out on purpose:** suggestion chips, Apply buttons on code, model-written badges, remote images, link previews, per-word fades, and tool or plan cards inside the answer (those belong to the work line).
- **The work line.** It is open while the agent works (step N of M, a step meter, a live clock) and folds itself the moment the reply settles. Open it and the steps are listed in order, with what the agent said, read, ran and changed. Lookups are one line; commands and diffs keep their bordered cards. Toggling it yourself sticks until the run moves to its next phase.
- **While it works.** Enter queues a message; it goes out when the run settles, shown as a "Next" row with Send now and ×. Shift Enter sends now, straight into the run, where it shows inline as "You said …".
- **Edit and rerun** your last or any earlier message. **Run this again** regenerates the last reply.
- **Follow the end** while streaming. Scroll up and it stops pulling you down, and offers "Jump to latest" instead.
- **List.** Needs you is pinned. Each row's second line shows what the thread is doing, what it wants or what it left. Search with Ctrl K; Enter opens the first match. Alt ↑/↓ moves between threads, Ctrl N starts a new one, and Esc closes Review.

## Scenes

| Scene | Shows |
| --- | --- |
| Running | Step 3 of 4: tests stream into a bordered card, then the docs step runs, then it settles into an answer with 4 files and 2 met checks (~17s; Replay restarts it) |
| Needs you | An approval. Allow once runs the install, re-runs the e2e 20 times and settles. Deny stops it with a reason |
| Review · 2 turns | A finished thread with a follow-up. Send another message and it runs and answers |
| Ask answer | Ask mode: an answer with a code block, nothing changed |
| Rich answer | One realistic answer that uses every element: diagram, file chips, numbered code, table, chart, alert, diff, shell, keys, task list, fold. It streams in on open (Replay writes it again) |
| Failed | What broke, in words, where, and the failed command open. Retry runs again and finishes |
| New thread | An empty start. Type, or pick a suggestion, and a thread is created and runs |

## Kept from earlier decisions

- Terminal output and diffs stay in bordered cards, in every direction (the 2026-09-21 revert).
- The composer keeps its anatomy: field over one control row, Agent | Ask (Shift Tab in an empty box), model · effort, context, attach, and a labelled `Send ↵` / `Queue ↵`. Stop stays in the thread header.
- The placeholder follows where the thread stands.
- Approvals stay one accent card, placed where you are already reading.
- No hex values, no new opacities, no off-scale type.

## Departures to decide on

- **"Feels like a chat"**: A and C bring back a message bubble for what you said. That reverses the 2026-09-23 "no chatbot look" pick. B keeps the brief framing.
- The vocabulary moves from "task" to "thread", only because you asked for "chat threads". Either word ports.
- C gives the inspector's job for the selected reply (Work, Changes, Terminal) to a pane tied to that reply. Porting C means deciding how it sits beside the existing six-tab inspector.

## How it is built

- `data.ts`: 10 threads, each with its own work. `session` is the rich answer: one realistic reply that uses every element. None borrows another's.
- `store.tsx`: one reducer. Live runs are scripted as beats: pure `Thread → Thread` functions applied on a timer. That way every direction shows the same run going from live to settled, and StrictMode can't duplicate a step.
- `parts.tsx`: everything the directions share (cards, steps, results, approval, composer), so they differ only in structure.
- `a/`, `b/`, `c/`: one file per direction.
