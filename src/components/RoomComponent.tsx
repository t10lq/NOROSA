import { useEffect, useReducer, useRef, useState } from 'react'
import { useE2e } from '../context/E2eContext'
import { HedgehogLogo } from './HedgehogLogo'
import {
  getChatGroup,
  getChatMessages,
  getChatNote,
  getChatPeers,
  getChatSafety,
  getChatSafetyMap,
  pushLocalMessage,
  subscribeRoomChat,
} from './roomChat'

/**
 * Encrypted room chat panel — a pure view over the shared roomChat store.
 *
 * The heavy lifting (bootstrapping the Megolm group, establishing X3DH
 * sessions, key distribution, and decryption) lives in the always-mounted
 * RoomReceiver; this panel only renders what the store contains. Hiding the
 * panel no longer costs you messages.
 */

const WIDTH = 340

export function RoomComponent({ userId, onClose }: { userId: string; onClose?: () => void }) {
  const { service, isReady, error } = useE2e()

  // When an onClose handler is present this panel is a full-screen overlay
  // (mobile); otherwise it is the desktop side rail.
  const full = onClose !== undefined

  const [draft, setDraft] = useState('')
  const [sendErr, setSendErr] = useState<string | null>(null)
  const [, force] = useReducer(x => x + 1, 0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const messages = getChatMessages()
  const groupId = getChatGroup()
  const peers = getChatPeers()
  const safetyMap = getChatSafetyMap()
  const peerNote = getChatNote()
  const selfAlias = service?.selfAlias ?? userId
  // Fingerprints visible only for peers actually in the room right now: a
  // departed member's row drops away with them.
  const safetyRows = peers.map(p => ({ peer: p, status: getChatSafety(p)! })).filter(x => x.status)
  const anyChanged = safetyRows.some(x => x.status.changed)

  useEffect(() => subscribeRoomChat(force), [])
  // Bottom-anchored like a typical chat app: on first open and whenever a new
  // message lands, stick to the newest message — unless the reader is already
  // scrolling through history.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = async () => {
    const text = draft.trim()
    if (!text || !service || !groupId) return
    setDraft('')
    setSendErr(null)
    pushLocalMessage(selfAlias, text)
    try {
      await service.encryptGroupMessage(groupId, text)
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : 'Encryption failed.')
    }
  }

  if (!isReady) {
    return <BootPanel error={error} full={full} onClose={onClose} />
  }

  const encrypted = groupId !== null

  return (
    <div style={{
      width: full ? '100%' : WIDTH,
      minWidth: full ? 0 : WIDTH,
      maxWidth: '100%',
      background: 'rgba(10,10,11,0.92)',
      borderLeft: full ? 'none' : '1px solid rgba(255,255,255,0.09)',
      borderRight: full ? '1px solid rgba(255,255,255,0.09)' : 'none',
      display: 'flex', flexDirection: 'column', height: '100%',
      backdropFilter: 'blur(24px)',
      animation: 'slideInRight 0.28s cubic-bezier(0.4,0,0.2,1)',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.09)',
        flexShrink: 0, maxHeight: '48%', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={encrypted ? 'rgba(240,238,233,0.55)' : 'rgba(240,238,233,0.25)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span style={{ fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.12em', color: encrypted ? 'rgba(240,238,233,0.4)' : 'rgba(240,238,233,0.25)' }}>
            END-TO-END ENCRYPTED
          </span>
          {onClose && (
            <button onClick={onClose}
              className="tap"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(240,238,233,0.4)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>×</button>
          )}
          {!onClose && (
            <span style={{
              marginLeft: 'auto', width: 5, height: 5, borderRadius: '50%',
              background: encrypted ? 'rgba(240,238,233,0.35)' : 'rgba(240,238,233,0.12)',
              animation: 'breathe 3s ease infinite',
            }} />
          )}
        </div>

        <div style={{ fontFamily: "'Space Mono'", fontSize: 9, letterSpacing: '0.09em', lineHeight: 1.6 }}>
          {safetyRows.length === 0 ? (
            <span style={{ color: '#3A3A3F' }}>{peers.length > 0 ? 'FINGERPRINTING…' : 'AWAITING PEER'}</span>
          ) : safetyRows.map(({ peer, status }) => (
            <div key={peer} style={{ display: 'flex', gap: 7, alignItems: 'baseline', whiteSpace: 'nowrap', flexWrap: 'wrap', flexShrink: 0 }}>
              <span style={{ color: status.changed ? '#B3241F' : '#3A3A3F', minWidth: 0 }}>
                {status.changed ? '⚠ ' : ''}{peer}
              </span>
              <span style={{ color: status.changed ? '#B3241F' : 'rgba(240,238,233,0.4)' }}>{status.number}</span>
            </div>
          ))}
        </div>
        {anyChanged && (
          <div style={{ marginTop: 7, padding: '7px 9px', border: '1px solid rgba(179,36,31,0.35)', borderRadius: 7, background: 'rgba(179,36,31,0.08)' }}>
            <p style={{ margin: 0, fontFamily: "'Space Mono'", fontSize: 8, letterSpacing: '0.08em', lineHeight: 1.6, color: '#E0635E' }}>
              SAFETY NUMBER CHANGED · The peer's identity differs from our first contact. Do not trust this conversation — re-verify the digits out of band.
            </p>
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
        {messages.length === 0
          ? (
            <p style={{ padding: '34px 20px', textAlign: 'center', color: '#3A3A3F', fontSize: 13, fontWeight: 400, lineHeight: 1.6 }}>
              {peerNote ?? `Delivered as ciphertext.${'\n'}Even the server cannot read it.`}
            </p>
          )
          : messages.map(m => (
            <div key={m.id} style={{ padding: '7px 20px' }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', marginBottom: 3 }}>
                <span style={{ fontFamily: "'Space Mono'", fontSize: 10, color: m.alias === selfAlias ? 'rgba(240,238,233,0.5)' : '#3A3A3F', letterSpacing: '0.06em' }}>
                  {m.alias === selfAlias ? 'you' : m.alias}
                </span>
                <span style={{ fontSize: 10, color: '#2A2A2F' }}>
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 14, color: '#F0EEE9', lineHeight: 1.55, fontWeight: 400 }}>{m.text}</p>
            </div>
          ))
        }
      </div>

      {/* Composer */}
      <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.09)' }}>
        {sendErr && (
          <p style={{ margin: '0 0 10px', fontFamily: "'Space Mono'", fontSize: 9, letterSpacing: '0.06em', color: '#B3241F' }}>
            {sendErr.toUpperCase()}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder={encrypted ? 'Message…' : 'Starting encryption…'}
            disabled={!encrypted}
            style={{
              flex: 1, minWidth: 0,
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.11)',
              borderRadius: 8, padding: '9px 13px', color: '#F0EEE9', fontSize: 14,
              fontFamily: 'Outfit', fontWeight: 400, outline: 'none', transition: 'border-color 0.2s',
              opacity: encrypted ? 1 : 0.45,
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.11)')}
          />
          <button onClick={() => void send()} disabled={!encrypted} style={{
            padding: '0 14px', background: 'rgba(240,238,233,0.07)', border: '1px solid rgba(255,255,255,0.11)',
            borderRadius: 8, color: '#F0EEE9', fontSize: 15, cursor: encrypted ? 'pointer' : 'not-allowed',
            fontFamily: 'Outfit', transition: 'all 0.18s', opacity: encrypted ? 1 : 0.45,
          }}
            onMouseEnter={e => { if (encrypted) e.currentTarget.style.background = 'rgba(240,238,233,0.12)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.07)' }}
          >↑</button>
        </div>
        <p style={{ margin: '10px 0 0', textAlign: 'center', fontFamily: "'Space Mono'", fontSize: 8, letterSpacing: '0.1em', color: '#2A2A2F' }}>
          {encrypted ? 'MEGOLM GROUP CIPHER · KEY SHARED PER-MEMBER' : 'KEY EXCHANGE IN PROGRESS'}
        </p>
      </div>
    </div>
  )
}

function BootPanel({ error, full, onClose }: { error: string | null; full?: boolean; onClose?: () => void }) {
  return (
    <div style={{
      width: full ? '100%' : WIDTH,
      minWidth: full ? 0 : WIDTH,
      background: 'rgba(10,10,11,0.92)',
      borderLeft: full ? 'none' : '1px solid rgba(255,255,255,0.09)',
      borderRight: full ? '1px solid rgba(255,255,255,0.09)' : 'none',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 16, padding: '30px 26px',
      height: '100%', backdropFilter: 'blur(24px)',
      animation: 'slideInRight 0.28s cubic-bezier(0.4,0,0.2,1)',
      position: 'relative',
    }}>
      {onClose && (
        <button onClick={onClose}
          className="tap"
          style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'rgba(240,238,233,0.4)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>×</button>
      )}
      <div className="hlog-breathe">
        <HedgehogLogo size={54} tone={error ? 'red' : 'light'} />
      </div>
      {error ? (
        <>
          <p style={{ margin: 0, textAlign: 'center', fontSize: 13, color: '#B3241F', lineHeight: 1.6, fontWeight: 400 }}>
            {error}
          </p>
          <p style={{ margin: 0, textAlign: 'center', fontFamily: "'Space Mono'", fontSize: 9, letterSpacing: '0.1em', color: '#3A3A3F' }}>
            EXIT AND RE-ENTER THE ROOM
          </p>
        </>
      ) : (
        <>
          <p style={{ margin: 0, textAlign: 'center', fontSize: 15, color: '#F0EEE9', letterSpacing: '-0.01em' }}>
            جارٍ تحميل بروتوكول التشفير…
          </p>
          <p style={{ margin: 0, textAlign: 'center', fontFamily: "'Space Mono'", fontSize: 9, letterSpacing: '0.12em', color: '#3A3A3F' }}>
            KEY EXCHANGE · DOUBLE RATCHET · MEGOLM
          </p>
        </>
      )}
    </div>
  )
}