import { HedgehogLogo } from '../../../components/HedgehogLogo'

export function JoinRejected({ reason, onBack }: { reason: string; onBack: () => void }) {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', background: '#0A0A0B', padding: '0 24px', gap: 16, textAlign: 'center',
    }}>
      {/* App logo snug inside a translucent prohibition ring; the slash crosses the exact centre */}
      <div style={{ position: 'relative', width: 88, height: 88, marginBottom: 6 }}>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.88 }}>
          <HedgehogLogo size={60} />
        </div>
        <svg width="88" height="88" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <circle cx="44" cy="44" r="32" fill="none" stroke="rgba(179,36,31,0.55)" strokeWidth="3.5" />
          <line x1="22.8" y1="22.8" x2="65.2" y2="65.2" stroke="rgba(179,36,31,0.6)" strokeWidth="4.5" strokeLinecap="round" />
        </svg>
      </div>
      <h2 style={{ fontFamily: "'Space Mono'", fontSize: 18, fontWeight: 700, letterSpacing: '0.12em', color: '#F0EEE9', margin: 0 }}>
        ROOM NOT FOUND
      </h2>
      <p style={{ fontSize: 13, color: 'rgba(240,238,233,0.6)', maxWidth: 340, lineHeight: 1.55, margin: 0 }}>{reason}</p>
      <button onClick={onBack} style={{
        marginTop: 8, padding: '12px 34px', background: 'rgba(240,238,233,0.08)',
        border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10,
        color: '#F0EEE9', fontSize: 14, fontFamily: 'Outfit', fontWeight: 500, cursor: 'pointer',
        transition: 'all 0.18s',
      }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.14)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.08)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)' }}
      >BACK TO LOBBY</button>
    </div>
  )
}