---
title: Troubleshooting
description: "What the app's error messages mean and what to do about each one: keys, providers, MCP servers, the proxy, settings, updates, worktrees and start-up."
group: Reference
order: 4
---

Most problems say what they are in the app itself. This page collects those messages, what causes each one, and where the fix is. Logs are always written locally: Settings, "Diagnostics" shows where and has "Open folder".

## Keys and providers

| You see | What it means | What to do |
| --- | --- | --- |
| "Add an API key for …" above the brief, and Start is blocked | The provider this task uses has no key saved | "Add API key", or Settings, "Providers" |
| "This task’s custom endpoint was removed" | The task's model was on a custom endpoint that no longer exists | Pick another model, or add the endpoint again ("Open Providers") |
| "… isn’t ready" | The model list couldn't be fetched, usually because the provider can't be reached | Check the connection, then "Recheck" |
| "…: no model list" | The server answers but has no model list | Nothing blocks the task. Type the model ID in the picker |
| The provider's message, or "Authentication failed (HTTP 401)" (or 403) when it sends none | The key was refused | Replace the key in Settings, "Providers". There is no Retry for this: the same key would be refused again |
| The provider's message, or "Rate limited (HTTP 429)" when it sends none | The provider is limiting you | Nothing. The task retries on its own until the provider accepts it |
| "Insufficient provider credits for this request." (OpenRouter: "credits are insufficient") | The account is out of credit | Add credit with the provider, then send a follow-up. There is no Retry for this one |
| "Reconnecting (attempt N)" | The network or the provider dropped | Nothing. While offline the app checks every 2 seconds. After a provider error it waits up to 30 seconds between tries. Stop the task if you'd rather |
| "Connection lost. Retry when back online." | The connection dropped and the task stopped | Retry or Continue once you're back online |
| "Context still exceeds the model window after compaction" | The conversation is too long for this model even after it was summarized | Start a new task, compact manually, or pick a model with a larger window |
| "Saved API keys could not be read" | `secrets.json` is damaged, so the app won't write to it | Fix or move `secrets.json` out of the app's data folder, then enter your keys again |
| "OS secure storage is unavailable on this system, so API keys cannot be saved." | The system keychain isn't available to the app | On Linux, start the app with a supported password store, such as `--password-store=gnome-libsecret` |

A model name the provider doesn't know fails when the task starts, with the provider's own message. The app doesn't check model names ahead of time.

Other stops name their cause in the task, for example "The model hit its output token limit before finishing this turn.", "The model returned an empty response." or "The provider stopped the response because of a content filter."

## MCP servers

A server's state shows in Extensions: "Connection failed", "Needs sign-in", "Needs …" (a missing program) or "Not connected".

- **"… was not found on PATH, so this MCP server cannot start."** The server's program (often `uvx` or `npx`) isn't installed, or the app can't see it. Use "Install …" or "Locate binary…", then "Retry".
- **"Installed, not connected — sign in to use its tools."** Use "Sign in" (or "Sign in with GitHub", "Sign in with Google", or "Add token"). If the server can't register the app itself, you're asked for its OAuth client ID and secret.
- **Network messages** name the host and the likely cause: "Could not find … — check the URL and your DNS", "refused the connection — check the URL and port", "Timed out reaching … — check your network or proxy", "TLS certificate rejected … — a proxy may be intercepting HTTPS". Fix the cause, then "Retry". A short network failure is tried up to three times before a server is reported down. Home lists a failing server under "Needs you" too.

When a server asks you something while one of its tools runs, the question appears in the task the way the agent's own questions do. "Skip — let the agent choose" tells the server you declined. Unattended tasks with questions set to skip decline without asking.

## Proxy

Settings, "General", "Network" shows which proxy is in use ("Direct connection", or the address and where it came from). An address that can't be used is refused under the field when you leave it, for example "Only http:// and https:// proxies are supported." or "Leave the password out of the address." For a proxy that needs a password, set `HTTPS_PROXY` before starting the app. "The system proxy is a SOCKS proxy; provider calls go direct." means provider calls don't use the system proxy.

## Settings

- **"Settings couldn't be read"** in the inbox: `settings.json` was damaged. The app started with defaults and kept the damaged file beside it as `settings.json.corrupt-<time>`.
- **"Settings were not saved: settings.json could not be read"**: another program holds the file open. Close it and change the setting again. Your saved settings are never replaced with defaults while this lasts.

See [Data and storage](/docs/data-and-storage) for where each file lives.

## Updates

The update chip shows the new version followed by "failed", and its panel says "Update failed"; Settings, "About" says "The update check failed". Both show the error underneath. "Try the download again" or "Try again" repeats it. Background checks that fail stay quiet and never replace what you last saw. Nothing downloads until you ask.

## Worktrees and git

- **"Merging would conflict in N files — nothing was merged"**: nothing was merged and the folder it came from is unchanged. Uncommitted files in the worktree may now be committed on its branch.
- **"Couldn’t delete the worktree folder — something still has a file open in it"**: close the program using a file there (an editor, a terminal) and discard again.
- **"This repository's git settings run programs. Vyotiq's git skips them."**: the repository's git config names programs (filters, diff or merge drivers, a custom fsmonitor). The app's own git leaves them out until you choose "Allow for this repo".

## Commands and spending

- An approval card that says a command "Asks whatever the approval settings say" is from the command guard: force-pushes, discarding all changes, formatting a drive and similar ask every time, with only "Allow once" and "Deny".
- **"Spend limit reached"**: the task asks whether to spend more. "Stop here" ends it; a follow-up asks again. Change the limit in Settings, "Agent", "Spend limit per task".
- **"Stopped after 500 steps without finishing."**: the record and task list are kept. Send a follow-up to carry on.

## Start-up and quitting

- **"Vyotiq failed to start. Check the logs for details."**: open the logs folder (next to `settings.json`, in `logs/`) and look at the end of `vyotiq.log`.
- Starting the app a second time brings the open window forward instead of opening a second copy.
- **"Vyotiq is still saving run data. Quit anyway?"** appears only when writing a task's record really takes more than a few seconds, usually because the disk is busy. "Wait" keeps trying for up to a minute; "Quit anyway" may lose the last moments of that record.

## Indexing and dictation

- Settings, "Indexing" shows each open workspace's index as "Ready", "Error", "Paused" or "Not indexed", with the error text underneath. "Reindex" (or "Index now") scans the workspace and updates what changed; "Resume" carries on from where it stopped.
- A dictation take that fails keeps its audio: "Retry", "Discard", or try the other engine. "Add key", "Providers" and "Install" appear when the cause is a missing key, a refused key or a missing model.
- "Windows is blocking the microphone" (or macOS) names the system setting to change.
