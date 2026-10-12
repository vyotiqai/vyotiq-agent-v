---
title: Notifications and closing
description: Where Agent V tells you things, notifications on your phone, sound and quiet hours, budget alerts, and what closing the window or quitting does to running tasks.
group: Reference
order: 6
---

## Notifications

Settings, "Notifications" decides how Agent V gets your attention.

Under "Delivery":

| Setting | What it does |
| --- | --- |
| "Notifications" | The inbox, toasts in the window, desktop alerts, and what screen readers announce |
| "Desktop alerts" | The operating system's notifications, on top of the inbox |
| "Sound" | Desktop alerts play the system sound |
| "Quiet hours" | No desktop alerts between "From and to" (local time; a range can run past midnight). The inbox still fills |

Under "Events", choose which of these notify: "A task needs you", "A task finished", "A task failed", and "System alerts" ("When the window recovers from a crash, an update is ready to install, or spend reaches a budget"). Budgets are set in Settings, "Agent", "Cost"; see [Usage and cost](/docs/usage-and-cost#daily-and-monthly-budgets).

## On your phone

Under "On your phone", Agent V can send the same notifications off this computer, so a task that needs you reaches you away from the desk.

| Setting | What it does |
| --- | --- |
| "Send to your phone" | "Off", "ntfy" or "Webhook" |
| "Address" | Where to send them. It is kept in the key vault, not in `settings.json`, since anyone holding it can post to you |
| "When" | "When away" (the default) sends only while the window is in the background, minimized or in the tray; "Always" sends every one |
| "Check it" | "Send a test" sends one message now, and says what the server answered if it refused |

- **ntfy:** install the ntfy app on your phone, subscribe to a topic, and give Agent V the same topic's address, such as `https://ntfy.sh/your-topic`. Pick a topic name nobody would guess: on the public server, anyone who knows it can read it. A self-hosted ntfy server works the same way. A task that needs you or failed arrives at high priority.
- **Webhook:** Agent V posts one JSON body to the address, with `text` (which Slack reads), `content` (which Discord reads) and `kind`, `title`, `body` and `at` for a script of your own. A Slack or Discord incoming-webhook address works as it is.

The events are the ones chosen under "Events", and quiet hours hold phone notifications back as they do desktop alerts.

## Closing the window

On Windows and Linux, closing the window quits Agent V, and quitting stops every running task. Loops and scheduled tasks wait until the app is open again. Settings, "General", "Closing" changes that:

- **"Keep running in the tray"**: closing the window hides it, and tasks, loops and scheduled tasks keep going. The first time in a session, Windows shows a note, "Agent V is still running". Quit from the tray icon.
- **"Ask before quitting with tasks running"** (on by default): with tasks running, closing or quitting asks "Quit Agent V? {n} tasks are running." first, with "Keep running in the tray", "Quit and stop them" and "Cancel", and a box to always keep running in the tray.

On macOS, closing the window leaves the app running, as usual there; quitting asks the same question.

## The tray icon

The tray icon's menu has "Show Agent V", the running tasks (a task waiting on you reads "Needs you · {task}"; clicking one opens it), "New task", "Stop all tasks ({n})" (it asks first) and "Quit Agent V". It changes as tasks start and end.

## Related

- [Approvals](/docs/approvals) for what a task waits on you for
- [Scheduled tasks](/docs/scheduled-tasks)
