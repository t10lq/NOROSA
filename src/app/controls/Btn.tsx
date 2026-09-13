import { useState } from 'react'
import type { ReactNode } from 'react'

// ── Control button ────────────────────────────────────────────────
export function Btn({ onClick, active = true, danger = false, title, pending = false, disabled = false, children }: {
  onClick: () => void; active?: boolean; danger?: boolean; title: string; pending?: boolean; disabled?: boolean; children: ReactNode
}) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      className="tap"
      style={{
        width: 46, height: 46, borderRadius: '10px', cursor: pending || disabled ? 'progress' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        touchAction: 'manipulation', opacity: disabled ? 0.55 : 1, pointerEvents: disabled ? 'none' : 'auto',
        border: danger
          ? `1px solid ${hov ? 'rgba(179,36,31,0.7)' : 'rgba(179,36,31,0.3)'}`
          : `1px solid ${hov ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)'}`,
        background: danger
          ? (hov ? 'rgba(179,36,31,0.28)' : 'rgba(179,36,31,0.12)')
          : (hov || pending ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)'),
        color: danger ? '#B3241F' : active ? 'rgba(240,238,233,0.85)' : 'rgba(240,238,233,0.3)',
        transition: 'all 0.2s ease',
        backdropFilter: 'blur(12px)',
        position: 'relative',
      }}>
      {pending && <span style={{ position: 'absolute', top: 9, right: 9, width: 5, height: 5, borderRadius: '50%', background: '#F0EEE9', animation: 'breathe 0.9s ease infinite' }} />}
      {children}
    </button>
  )
}