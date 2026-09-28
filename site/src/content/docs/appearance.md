---
title: Appearance
description: Change Agent V's skin, colour mode, text size and density, and load your own CSS on top.
group: Reference
order: 2
---

Settings, "Appearance" covers "Skin, colour mode, type size and density. Changes apply as you pick." There is no save button.

## Skins

A skin sets the app's type, colours and corners. Every skin has a light and a dark version.

| Skin | Look |
| --- | --- |
| Native | System type, branding orange |
| Default | Neutral grey, azure instrument |
| Proof | Dusk contrast for long reading |
| Bench | Workshop blue, the squarest corners |
| Gild | Alabaster and onyx, blue slate |

Native is the skin Agent V starts with. The one named "Default" is a separate skin, not the starting one.

## Colour mode

"Colour mode" has three choices:

| Choice | Effect |
| --- | --- |
| "System" | Follows your operating system's light or dark setting |
| "Light" | Always light |
| "Dark" | Always dark |

Agent V starts on "System".

## Text size

"Text size" has "Small", "Default" and "Large". You can also change it from anywhere with the keyboard:

| Shortcut | Effect |
| --- | --- |
| `Ctrl+=` | Larger text |
| `Ctrl+-` | Smaller text |
| `Ctrl+0` | Reset text size |

On macOS use `⌘` instead of `Ctrl`.

## Density

"Density" sets "Row and control height." Choose "Compact", "Default" or "Comfortable". Compact fits more rows on screen; Comfortable gives each row more room.

## User CSS overlay

Under "Custom CSS", "User CSS overlay" loads a stylesheet of your own on top of the skin.

1. Click "Choose file…" and pick a `.css` file in the file dialog.
2. The path then shows in the setting. "Change…" picks another file and "Clear" removes it.

The rules for the file: "Overrides --vy-* tokens. Remote @import is stripped; 256 KB max."

The app's colours, spacing and type are defined as CSS custom properties whose names start with `--vy-`. Your file overrides them.

Keep in mind:

- An `@import` that points at a remote URL is removed, so the file cannot pull in other stylesheets from the web.
- Files over 256 KB are refused.
- Agent V watches the file. When you save a change to it, the overlay reloads.
- Your overrides apply on top of every skin and both colour modes, so check the result in light and dark.

## Related

- [Keyboard shortcuts](/docs/keyboard-shortcuts)
- [Data and storage](/docs/data-and-storage) for where settings are saved
