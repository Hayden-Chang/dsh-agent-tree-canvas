/** Inline editing delegates acceptance and persistence to the owning Session. */
import { useRef, useState } from 'react'
import { Button, Input, Tooltip, IconEditOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './view.module.css'

export function NodeName({ title, label, disabled, rename }: {
  readonly title: string
  readonly label: string
  readonly disabled: boolean
  readonly rename: (title: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const current = useRef<string | null>(null), pending = useRef(false)
  const finish = (): void => { current.current = null; setDraft(null) }
  const save = async (): Promise<void> => {
    const value = current.current
    if (value === null || pending.current) return
    if (!value.trim() || value === title) { finish(); return }
    pending.current = true; setSaving(true)
    try { if (await rename(value)) finish() }
    finally { pending.current = false; setSaving(false) }
  }
  return <span className={css.nodeName}>
    <Tooltip label={label} side="top" portal>
      <Button size="sm" aria-label={label} disabled={disabled || saving} onClick={() => {
        current.current = title; setDraft(title)
      }}><IconEditOutlineRegular size={16} /></Button>
    </Tooltip>
    {draft === null ? <span className={css.nodeTitle} title={title}>{title}</span>
      : <span className={css.nodeTitle}><Input aria-label={label} className={css.nodeNameInput} autoFocus readOnly={saving}
        value={draft} onFocus={event => { event.currentTarget.select() }}
        onChange={event => { current.current = event.target.value; setDraft(event.target.value) }}
        onClick={event => { event.stopPropagation() }} onBlur={() => { void save() }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save() }
          if (event.key === 'Escape' && !pending.current) { event.preventDefault(); event.stopPropagation(); finish() }
        }} /></span>}
  </span>
}
