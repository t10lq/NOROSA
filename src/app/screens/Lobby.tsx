import { useState } from 'react'
import { HedgehogLogo } from '../components/HedgehogLogo'
import { normalizeRoomCode, isValidCode } from '../../net/roomcode'
import { useMediaQuery } from '../ui/useMediaQuery'

// ── Lobby ─────────────────────────────────────────────────────────
export function Lobby({ alias, onCreateRoom, onJoinRoom }: {
  alias: string; onCreateRoom: () => void; onJoinRoom: (code: string) => void
}) {
  const [joinCode, setJoinCode] = useState('')
  const [mode, setMode] = useState<'choose' | 'join'>('choose')
  const isMobile = useMediaQuery('(max-width: 700px)')

  // A valid code is EXACTLY 18 hex digits (6 groups of 3). Anything else —
  // pasted plans, empty, too short, stray letters — is refused right here so
  // the user never leaves the lobby on garbage.
  const joinNorm = joinCode ? normalizeRoomCode(joinCode) : ''
  const joinValid = joinNorm.length === 18 && isValidCode(joinNorm)
  const joinHint = joinCode.length > 0 && !joinValid
    ? (joinNorm.length > 18 ? 'TOO LONG — A ROOM CODE IS EXACTLY 18 HEX DIGITS' : 'ROOM CODE IS 6 GROUPS × 3 HEX DIGITS')
    : null
  const joinBad = joinCode.length > 0 && !joinValid

  return (
    <div style={{
      minHeight: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: isMobile ? '36px 16px' : '55px 21px',
    }}>
      {/* Brand */}
      <div style={{ textAlign: 'center', marginBottom: isMobile ? 36 : 62 }}>
        <div className="hlog-settle" style={{ marginBottom: isMobile ? 22 : 26 }}>
          <HedgehogLogo size={isMobile ? 72 : 92} />
        </div>
        <h1 style={{
          fontFamily: "'Space Mono'", fontSize: isMobile ? 30 : 36, fontWeight: 700,
          letterSpacing: '0.22em', color: '#F0EEE9', margin: '0 0 14px',
        }}>Norosa</h1>
        <p style={{
          fontFamily: 'Outfit', fontSize: isMobile ? 13 : 14, color: '#4A4A52',
          fontWeight: 400, letterSpacing: '0.04em', margin: 0,
        }}>The server only knocks. It never listens.</p>
      </div>

      {/* Card */}
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'rgba(17,17,19,0.8)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 16, padding: isMobile ? 24 : 34, marginBottom: 24,
        backdropFilter: 'blur(20px)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
      }}>
        {/* Identity — read only */}
        <div style={{ marginBottom: isMobile ? 22 : 28 }}>
          <label style={{
            display: 'block', fontFamily: "'Space Mono'", fontSize: '10px',
            letterSpacing: '0.12em', color: '#3A3A3F', marginBottom: 10,
          }}>YOUR ANONYMOUS IDENTITY</label>
          <div style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 8, padding: '12px 16px',
            fontFamily: "'Space Mono'", fontSize: 14,
            color: 'rgba(240,238,233,0.75)', letterSpacing: '0.04em',
          }}>{alias}</div>
          <p style={{ margin: '8px 0 0', fontSize: 11, color: '#2E2E35', fontWeight: 400 }}>
            Generated locally. Locked for this session.
          </p>
        </div>

        {mode === 'choose' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: isMobile ? 20 : 28 }}>
            <button onClick={onCreateRoom} style={{
              width: '100%', padding: '15px', background: 'rgba(240,238,233,0.07)',
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10,
              color: '#F0EEE9', fontSize: 15, fontFamily: 'Outfit', fontWeight: 500,
              cursor: 'pointer', letterSpacing: '0.01em',
              transition: 'all 0.22s ease',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.12)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.07)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)' }}
            >Create encrypted room</button>
            <button onClick={() => setMode('join')} style={{
              width: '100%', padding: '15px', background: 'none',
              border: '1px solid rgba(255,255,255,0.10)', borderRadius: 10,
              color: '#4A4A52', fontSize: 15, fontFamily: 'Outfit',
              cursor: 'pointer',
              transition: 'all 0.22s ease',
            }}
              onMouseEnter={e => { e.currentTarget.style.color = '#F0EEE9'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.20)' }}
              onMouseLeave={e => { e.currentTarget.style.color = '#4A4A52'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)' }}
            >Join with room code</button>
          </div>
        ) : (
          <div style={{ animation: 'fadeIn 0.2s ease' }}>
            <input autoFocus value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^0-9A-F-]/g, ''))}
              onKeyDown={e => e.key === 'Enter' && joinValid && onJoinRoom(joinCode)}
              placeholder="XXX-XXX-XXX-XXX-XXX-XX"
              style={{
                width: '100%', padding: '12px 16px', marginBottom: 10,
                background: 'rgba(255,255,255,0.03)',
                border: joinBad ? '1px solid rgba(179,36,31,0.55)' : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8, color: '#F0EEE9', fontSize: 14,
                fontFamily: "'Space Mono'", letterSpacing: '0.08em', outline: 'none',
                transition: 'border-color 0.2s',
              }}
              onFocus={e => (e.target.style.borderColor = 'rgba(255,255,255,0.22)')}
              onBlur={e => (e.target.style.borderColor = joinBad ? 'rgba(179,36,31,0.55)' : 'rgba(255,255,255,0.08)')}
            />
            {joinHint && (
              <p style={{ margin: '0 0 10px', fontSize: 11, color: '#B3241F', fontWeight: 400, fontFamily: "'Space Mono'", letterSpacing: '0.04em' }}>{joinHint}</p>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setMode('choose')} style={{
                flex: 1, padding: '12px', background: 'none',
                border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8,
                color: '#4A4A52', fontSize: 14, fontFamily: 'Outfit', cursor: 'pointer', transition: 'all 0.18s',
              }}
                onMouseEnter={e => { e.currentTarget.style.color = '#F0EEE9' }}
                onMouseLeave={e => { e.currentTarget.style.color = '#4A4A52' }}
              >Back</button>
              <button onClick={() => joinValid && onJoinRoom(joinCode)} disabled={!joinValid || joinCode.length === 0} style={{
                flex: 2, padding: '12px', background: 'rgba(240,238,233,0.08)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
                color: '#F0EEE9', fontSize: 14, fontFamily: 'Outfit',
                fontWeight: 500, cursor: (!joinValid || joinCode.length === 0) ? 'not-allowed' : 'pointer',
                opacity: (!joinValid || joinCode.length === 0) ? 0.4 : 1, transition: 'all 0.18s',
              }}
                onMouseEnter={e => { if (joinValid) e.currentTarget.style.background = 'rgba(240,238,233,0.14)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.08)' }}
              >Enter room</button>
            </div>
          </div>
        )}
      </div>

      {/* Trust indicators */}
      <div style={{ display: 'flex', gap: isMobile ? 24 : 40, justifyContent: 'center', flexWrap: 'wrap' }}>
        {[['Zero logs', 'Server stores nothing'], ['Ephemeral', 'Leaves no trace'], ['Blind server', 'Knocks — never listens']].map(([t, s]) => (
          <div key={t} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: 'rgba(240,238,233,0.35)', marginBottom: 3, fontWeight: 500 }}>{t}</div>
            <div style={{ fontSize: 11, color: '#2E2E35', fontWeight: 400 }}>{s}</div>
          </div>
        ))}
      </div>
    </div>
  )
}