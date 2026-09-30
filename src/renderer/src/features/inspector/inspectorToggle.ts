/**
 * The inspector as the rightmost pane's header offers it: whether it is on
 * screen, and the one call that shows or hides it (Ctrl I's).
 */
export type InspectorToggle = { open: boolean; onToggle: () => void }
