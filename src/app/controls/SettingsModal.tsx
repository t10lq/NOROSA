import { useState } from 'react'
import { MicPath, SpeakerPath, GearPath } from '../ui/icons'

// ── Settings modal ───────────────────────────────────────────────
interface AudioDeviceRowProps {
  label: string
  kind: 'in' | 'out'
  selected: boolean
  onSelect: () => void
  hint?: 'default' | 'ready' | 'blocked'
}

function AudioDeviceRow({ label, kind, selected, onSelect, hint }: AudioDeviceRowProps) {
  const [hov, setHov] = useState(false)
  const icon = kind === 'in' ? MicPath : SpeakerPath
  return (
    <button onClick={onSelect} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px', background: selected ? 'rgba(240,238,233,0.06)' : (hov ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)'),
      border: `1px solid ${selected ? 'rgba(240,238,233,0.28)' : hov ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.07)'}`,
      borderRadius: 8, cursor: 'pointer', textAlign: 'left',
      transition: 'all 0.18s ease', color: 'inherit', fontFamily: 'inherit',
    }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={selected ? 'rgba(240,238,233,0.7)' : '#5C5C63'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}
        dangerouslySetInnerHTML={{ __html: icon }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: 13.5, fontWeight: 400, color: selected ? '#F0EEE9' : (hov ? '#F0EEE9' : '#5C5C63'),
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', transition: 'color 0.18s',
        }}>{label}</span>
        {hint && (
          <span style={{
            display: 'block', marginTop: 2, fontFamily: "'Space Mono'", fontSize: 9,
            letterSpacing: '0.08em', color: hint === 'ready' ? 'rgba(240,238,233,0.35)' : (hint === 'blocked' ? '#B3241F' : '#2E2E35'),
          }}>
            {hint === 'ready'
              ? 'AUDIO PATH READY'
              : hint === 'blocked'
                ? 'MICROPHONE BLOCKED'
                : 'DEFAULT SOURCE'}
          </span>
        )}
      </span>
      <span style={{
        width: 11, height: 11, flexShrink: 0, borderRadius: 3,
        border: `1px solid ${selected ? 'rgba(240,238,233,0.6)' : 'rgba(255,255,255,0.14)'}`,
        background: selected ? 'rgba(240,238,233,0.9)' : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.18s ease',
      }}>
        {selected && <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#0A0A0B' }} />}
      </span>
    </button>
  )
}

export function SettingsModal({ open, onClose, input, output, selIn, selOut, micHint, onSelectIn, onSelectOut }: {
  open: boolean
  onClose: () => void
  input: MediaDeviceInfo[]
  output: MediaDeviceInfo[]
  selIn: string
  selOut: string
  micHint: 'idle' | 'ready' | 'blocked'
  onSelectIn: (id: string) => void
  onSelectOut: (id: string) => void
}) {
  const [tab, setTab] = useState<'out' | 'in'>('in')
  if (!open) return null

  const tabs = [
    { id: 'out' as const, label: 'OUTPUT', icon: SpeakerPath },
    { id: 'in' as const, label: 'INPUT', icon: MicPath },
  ]

  const list = tab === 'out' ? output : input
  const sel = tab === 'out' ? selOut : selIn
  const onSel = tab === 'out' ? onSelectOut : onSelectIn
  const hintRow = tab === 'out' ? undefined : (micHint === 'ready' ? 'ready' as const : micHint === 'blocked' ? 'blocked' as const : undefined)
  const emptyLabel = tab === 'out' ? 'output device' : 'microphone'

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 190,
      background: 'rgba(10,10,11,0.78)', backdropFilter: 'blur(12px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.2s ease',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 400,
        background: '#111113', border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 16, padding: '26px 28px 24px',
        boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
        animation: 'scaleIn 0.22s cubic-bezier(0.4,0,0.2,1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(240,238,233,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: GearPath }} />
          <span style={{ fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.14em', color: 'rgba(240,238,233,0.45)' }}>DEVICE SETTINGS</span>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', marginTop: 18, borderBottom: '1px solid rgba(255,255,255,0.07)', gap: 2 }}>
          {tabs.map(t => {
            const active = tab === t.id
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                padding: '10px 0', background: active ? 'rgba(240,238,233,0.04)' : 'none',
                border: 'none', borderBottom: `1px solid ${active ? 'rgba(240,238,233,0.4)' : 'transparent'}`,
                cursor: 'pointer', color: active ? '#F0EEE9' : '#5C5C63', fontFamily: 'inherit',
                transition: 'all 0.18s ease',
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={active ? 'rgba(240,238,233,0.7)' : '#5C5C63'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: t.icon }} />
                <span style={{ fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.1em' }}>{t.label}</span>
              </button>
            )
          })}
        </div>

        {/* Device list — fixed-height scroll area */}
        <div style={{
          height: 240, overflowY: 'auto', marginTop: 16,
          display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 2,
        }}>
          <AudioDeviceRow key="default" label="System default" kind={tab} selected={sel === 'default' || !sel} onSelect={() => onSel('default')} hint="default" />
          {list.length === 0 && (
            <p style={{
              margin: '14px 0 0', textAlign: 'center',
              fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.1em',
              color: '#2E2E35',
            }}>NO {tab === 'out' ? 'OUTPUT' : 'INPUT'} FOUND</p>
          )}
          {list.map(d => (
            <AudioDeviceRow key={d.deviceId} label={d.label || `Unnamed ${emptyLabel}`} kind={tab} selected={sel === d.deviceId} onSelect={() => onSel(d.deviceId)} hint={hintRow} />
          ))}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{
            padding: '11px 28px', background: 'rgba(240,238,233,0.08)',
            border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8,
            color: '#F0EEE9', fontSize: 14, fontFamily: 'Outfit', fontWeight: 500, cursor: 'pointer',
            transition: 'all 0.18s ease',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.14)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.08)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)' }}
          >Done</button>
        </div>
      </div>
    </div>
  )
}