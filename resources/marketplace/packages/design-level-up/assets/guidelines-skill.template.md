---
name: apple-hig
description: Apply Apple's Human Interface Guidelines when designing or reviewing iPhone, iPad, Mac, Apple Watch or visionOS screens, and any app-like interface where layout, type size, touch targets and color must follow platform rules. Use it for mockups, prototypes and design reviews, even when the user only says "app screen".
---

<!--
  TEMPLATE (design-level-up, Advanced trick 20). The same shape works for Material Design 3
  (Android), Fluent 2 (Windows) or WCAG 2.2 (accessibility): rename and refill.
  To build it:
  1. Copy to <skills folder>/apple-hig/SKILL.md.
  2. Have the agent read the official pages and fill each section in its own words, with a
     link per rule: developer.apple.com/design/human-interface-guidelines - start with
     Accessibility, Layout, Typography, Color, Buttons, Navigation and search, Tab bars,
     Designing for iOS (and the other platforms you ship).
  3. Write the date you checked at the top; guidelines change every year.
  4. Delete this comment. Summaries and links only: do not paste Apple's text wholesale.
-->

# Apple HIG, distilled

Source: https://developer.apple.com/design/human-interface-guidelines/ (checked YYYY-MM-DD).
Use this when a screen should feel native. When a rule here and a brand's DESIGN.md
disagree, the accessibility numbers win; the brand decides everything else.

## Numbers to hold
These were verified against the HIG Accessibility and Typography pages in September 2026;
re-check them when you refresh the skill.
- Touch targets: controls default to 44x44 pt; 28x28 pt is the minimum.
- Text: body defaults to 17 pt (Large Dynamic Type size, 22 pt leading); 11 pt is the floor.
- Contrast: at least 4.5:1 for text up to 17 pt, 3:1 for 18 pt and up or bold.
- Breathing room: about 12 pt of padding around bezeled controls, about 24 pt around unbezeled ones.

## Layout
<!-- Safe areas, margins, adaptivity across sizes and orientations, grouping. -->

## Typography
<!-- Dynamic Type support, the text styles, SF Pro vs custom fonts, weights. -->

## Color and materials
<!-- Semantic system colors, dark mode, never color alone for meaning, materials/vibrancy. -->

## Navigation
<!-- Tab bars vs sidebars vs navigation stacks; when to use each; back behavior. -->

## Controls and feedback
<!-- Buttons (styles, roles), toggles, pickers, alerts vs sheets, loading and empty states. -->

## Review checklist
- [ ] Every tappable thing meets the target size, with space between neighbors
- [ ] Text scales with Dynamic Type without clipping or overlap
- [ ] Contrast passes in light and dark
- [ ] Standard controls behave the way iOS users expect (placement, gestures, back)
- [ ] Meaning never rests on color alone
