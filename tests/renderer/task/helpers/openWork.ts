import { fireEvent } from '@testing-library/react'

/**
 * Opens every work line that is folded. A run that settled with an answer
 * folds its steps and the work around them behind one line ("Worked for 6s"),
 * so a test that reads that work opens it first, the way a reader would.
 */
export function openWork(container: HTMLElement): void {
  for (const button of container.querySelectorAll<HTMLElement>('[data-work-fold] > div > button[aria-expanded="false"]')) {
    fireEvent.click(button)
  }
}
