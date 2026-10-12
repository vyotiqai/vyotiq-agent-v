/**
 * Something outside the composer (a provider error's "Switch model") asking
 * the model picker to open. The picker in the same pane as `from` takes it;
 * with no pane, the first picker on the page does.
 */
export const OPEN_MODEL_PICKER_EVENT = 'vyotiq:open-model-picker'

export type OpenModelPickerDetail = { pane: Element | null }

/** True when a picker took the request. */
export function requestOpenModelPicker(from?: Element | null): boolean {
  const pane = from?.closest('[data-chat-pane]') ?? null
  const event = new CustomEvent<OpenModelPickerDetail>(OPEN_MODEL_PICKER_EVENT, {
    detail: { pane },
    cancelable: true
  })
  window.dispatchEvent(event)
  return event.defaultPrevented
}
