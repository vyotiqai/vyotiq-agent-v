/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRule } from '@shared/ipc'
import { PermissionRulesEditor } from '@renderer/features/settings/components/PermissionRulesEditor'

afterEach(cleanup)

describe('PermissionRulesEditor', () => {
  it('adds a rule from the kind, pattern and effect picked', () => {
    const onChange = vi.fn()
    render(<PermissionRulesEditor rules={[]} disabled={false} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Command' }))
    const input = screen.getByLabelText('New rule command')
    fireEvent.change(input, { target: { value: '  git push ' } })
    const effects = screen.getByRole('radiogroup', { name: 'New rule effect' })
    fireEvent.click(effects.querySelector('[role="radio"]:nth-child(2)')!)
    fireEvent.click(screen.getByRole('button', { name: /Add rule/ }))
    expect(onChange).toHaveBeenCalledWith([{ effect: 'ask', command: 'git push' }])
  })

  it('adds on Enter and refuses an empty or duplicate pattern', () => {
    const rules: PermissionRule[] = [{ effect: 'deny', path: '.env.local' }]
    const onChange = vi.fn()
    render(<PermissionRulesEditor rules={rules} disabled={false} onChange={onChange} />)
    const add = screen.getByRole('button', { name: /Add rule/ }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    const input = screen.getByLabelText('New rule path')
    fireEvent.change(input, { target: { value: '.env.local' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'secrets/**' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([...rules, { effect: 'deny', path: 'secrets/**' }])
  })

  it('changes a row in place and removes it', () => {
    const rules: PermissionRule[] = [
      { effect: 'deny', path: 'a/**' },
      { effect: 'allow', tool: 'read', path: 'docs/**' }
    ]
    const onChange = vi.fn()
    render(<PermissionRulesEditor rules={rules} disabled={false} onChange={onChange} />)
    const rowEffect = screen.getByRole('radiogroup', { name: 'Effect of path a/**' })
    fireEvent.click(rowEffect.querySelector('[role="radio"]:nth-child(2)')!)
    expect(onChange).toHaveBeenLastCalledWith([{ effect: 'ask', path: 'a/**' }, rules[1]])
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule: allow tool read, path docs/**' }))
    expect(onChange).toHaveBeenLastCalledWith([rules[0]])
  })

  it('lists the built-in protections', () => {
    render(<PermissionRulesEditor rules={[]} disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText(/Always denied: The app's data folder/)).toBeTruthy()
    expect(screen.getByText(/~\/\.ssh\/\*\*/)).toBeTruthy()
  })
})
