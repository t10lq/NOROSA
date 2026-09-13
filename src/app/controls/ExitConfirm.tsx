import { HedgehogLogo } from '../components/HedgehogLogo'

// ── Exit confirm ──────────────────────────────────────────────────
export function ExitConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(10,10,11,0.82)', backdropFilter: 'blur(12px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.2s ease',
    }}>
      <div style={{
        background: '#111113', border: '1px solid rgba(179,36,31,0.25)',
        borderRadius: 16, padding: '55px 50px', maxWidth: 400, width: '90%', textAlign: 'center',
        boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
        animation: 'scaleIn 0.22s cubic-bezier(0.4,0,0.2,1)',
      }}>
        <div style={{ marginBottom: 20, filter: 'drop-shadow(0 0 16px rgba(179,36,31,0.55))', transition: 'filter 0.3s ease' }}>
          <HedgehogLogo size={68} tone="red" />
        </div>
        <h2 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 500, color: '#F0EEE9', letterSpacing: '-0.01em' }}>Leave this room?</h2>
        <p style={{ margin: '0 0 34px', fontSize: 14, color: '#5C5C63', lineHeight: 1.65, fontWeight: 400 }}>
          Your device exits the room. The room code stays alive until every
          member has left — you can re-enter anytime and rejoin them.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={onCancel} style={{
            padding: '13px 32px', background: 'none', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8, color: '#5C5C63', cursor: 'pointer', fontSize: 14, fontFamily: 'Outfit',
            transition: 'all 0.18s',
          }}
            onMouseEnter={e => { e.currentTarget.style.color = '#F0EEE9'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#5C5C63'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
          >Stay</button>
          <button onClick={onConfirm} style={{
            padding: '13px 32px', background: '#B3241F', border: '1px solid #B3241F',
            borderRadius: 8, color: '#F0EEE9', cursor: 'pointer', fontSize: 14, fontFamily: 'Outfit',
            fontWeight: 500, transition: 'all 0.18s',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = '#8f1c18'; e.currentTarget.style.borderColor = '#8f1c18' }}
            onMouseLeave={e => { e.currentTarget.style.background = '#B3241F'; e.currentTarget.style.borderColor = '#B3241F' }}
          >Leave room</button>
        </div>
      </div>
    </div>
  )
}