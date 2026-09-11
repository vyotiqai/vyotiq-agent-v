---
title: Notifications
description: Configure the inbox and desktop toasts for completed, failed, blocked, and system events.
section: tools
order: 9
type: guide
audience: Background-run users
related:
  - agent/background-runs
  - concepts/privacy-data
  - reference/settings
---

Agent V notifications combine an in-app inbox with optional operating-system toasts.

## Configure notifications

Open [Settings → General](/docs/reference/settings) → Notifications.

Enable notifications is the master switch. When off, matching events are not stored in the inbox and no desktop notification is shown.

Category switches are:

- Agent run finished
- Agent run failed
- Agent needs you: approvals and questions
- System alerts: crash recovery and other system events

The current defaults enable the master switch and all four categories.

## Desktop notifications

Desktop notifications offers:

- Off
- When unfocused
- Always

The default is When unfocused. Minimized windows count as unfocused. Turning desktop notifications off does not disable matching inbox entries.

## Use the inbox

The sidebar inbox lists persisted notification items. Opening an actionable OS notification focuses the main window, marks the item read, and routes to its associated chat or surface when an action exists.

You can mark items read and dismiss individual or grouped items. Dismissal removes the inbox item and closes any corresponding live OS toast.

## Privacy and failure behavior

Notification title and body are bounded before storage. They can still reveal task or workspace context on the desktop, so use Off when the operating-system surface is not private.

If the operating system does not support notifications or showing a toast fails, the inbox remains the fallback. A toast is an alert, not proof that a run result was correct; open the chat and review the transcript and changes.
