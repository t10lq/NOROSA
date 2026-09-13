import { useState, useEffect, useCallback } from 'react'
import { HedgehogLogo } from './components/HedgehogLogo'
import { LoadingScreen } from './components/LoadingScreen'
import { E2eProvider, useE2e } from './context/E2eContext'
import { CallProvider } from './context/CallContext'
import { openDeviceKey } from './e2ee/vault'
import { formatRoomCode, generateRoomCode, hashRoomCode, isValidCode, normalizeRoomCode } from './e2ee/roomcode'
import { RELAY_URL } from './config/env'
import { generateAlias } from './app/ui/namegen'
import { Lobby } from './app/screens/Lobby'
import { Room } from './app/screens/Room'

const φ = 1.618033988749895

// ── Types ─────────────────────────────────────────────────────────
type View = 'lobby' | 'room'

// ── SecurityLine ──────────────────────────────────────────────────
function SecurityLine({ progress }: { progress: number }) {
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: '1px', zIndex: 50 }}>
      <div style={{
        height: '1px',
        width: `${progress}%`,
        background: progress === 100 ? 'rgba(240,238,233,0.18)' : '#B3241F',
        transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1), background 1.2s ease',
      }} />
    </div>
  )
}

// ── Room gate ─────────────────────────────────────────────────────
// The room UI must NEVER mount unless the relay actually accepted us and the
// crypto engine is ready. Until then the user sees a boot loader; a refused
// join shows a plain rejection screen — no grid, no controls, no "room".
function RoomGate({ roomCode, alias, onExit }: { roomCode: string; alias: string; onExit: () => void }) {
  const { isReady, error } = useE2e()

  if (error) {
    return isJoinRefusal(error)
      ? <JoinRejected reason={joinRefusalReason(error)} onBack={onExit} />
      : <BootFailure message={error} onBack={onExit} />
  }

  if (!isReady) return <RoomBootLoader />

  return (
    <CallProvider>
      <Room roomCode={roomCode} alias={alias} onExit={onExit} />
    </CallProvider>
  )
}

function isJoinRefusal(raw: string): boolean {
  return /room_not_found|bad_room_key|rate_limited|did not answer/.test(raw)
}

// Turn a raw relay refusal into a message the user can act on.
function joinRefusalReason(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('room_not_found')) return 'No room was created with that code — the room may have expired after everyone left.'
  if (m.includes('bad_room_key')) return 'The relay refused that code as malformed. Enter a valid 18-digit code exactly as shared.'
  if (m.includes('rate_limited')) return 'Too many join attempts from this browser in one minute — wait a minute, then try again.'
  if (m.includes('did not answer')) return 'The relay did not answer the join request. Check your connection and try again.'
  return raw
}

function RoomBootLoader() {
  const [dots, setDots] = useState('')
  useEffect(() => {
    const iv = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 400)
    return () => clearInterval(iv)
  }, [])
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', background: '#0A0A0B', gap: 18,
    }}>
      <p style={{ fontFamily: "'Space Mono'", fontSize: 13, letterSpacing: '0.14em', color: 'rgba(240,238,233,0.55)', margin: 0 }}>
        ENTERING ENCRYPTED ROOM{dots}
      </p>
      <p style={{ fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.1em', color: '#2E2E35', margin: 0 }}>
        HANDSHAKE · RATE-LIMIT CHECK · IDENTITY EXCHANGE
      </p>
    </div>
  )
}

function JoinRejected({ reason, onBack }: { reason: string; onBack: () => void }) {
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

function BootFailure({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', background: '#0A0A0B', padding: '0 24px', gap: 16, textAlign: 'center',
    }}>
      <h2 style={{ fontFamily: "'Space Mono'", fontSize: 18, fontWeight: 700, letterSpacing: '0.12em', color: '#F0EEE9', margin: 0 }}>
        COULD NOT START ENCRYPTION
      </h2>
      <p style={{ fontSize: 13, color: 'rgba(240,238,233,0.6)', maxWidth: 340, lineHeight: 1.55, margin: 0 }}>{message}</p>
      <button onClick={onBack} style={{
        marginTop: 8, padding: '12px 34px', background: 'rgba(240,238,233,0.08)',
        border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10,
        color: '#F0EEE9', fontSize: 14, fontFamily: 'Outfit', fontWeight: 500, cursor: 'pointer',
      }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.14)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(240,238,233,0.08)' }}
      >BACK TO LOBBY</button>
    </div>
  )
}

// ── App inner ─────────────────────────────────────────────────────
function AppInner({ view, alias, roomCode, onCreateRoom, onJoinRoom, onExit }: {
  view: View
  alias: string
  roomCode: string
  onCreateRoom: () => void
  onJoinRoom: (code: string) => void
  onExit: () => void
}) {
  const [progress, setProgress] = useState(0)
  const [loadPct, setLoadPct] = useState(0)
  const [hideLoad, setHideLoad] = useState(false)
  const [loadGone, setLoadGone] = useState(false)

  useEffect(() => {
    const start = Date.now()
    const iv = setInterval(() => {
      const pct = Math.min(100, Math.round(((Date.now() - start) / 2200) * 100))
      setLoadPct(pct)
      if (pct >= 100) {
        clearInterval(iv)
        setTimeout(() => setHideLoad(true), 350)
        setTimeout(() => setLoadGone(true), 1000)
      }
    }, 60)
    return () => clearInterval(iv)
  }, [])

  const exitRoom = () => { onExit() }

  return (
    <div style={{ height: '100%', background: '#0A0A0B', color: '#F0EEE9', fontFamily: 'Outfit, sans-serif' }}>
      <SecurityLine progress={progress} />
      {!loadGone && <LoadingScreen progress={loadPct} hidden={hideLoad} />}
      {view === 'lobby'
        ? <Lobby alias={alias} onCreateRoom={onCreateRoom} onJoinRoom={onJoinRoom} />
        : <RoomGate roomCode={roomCode} alias={alias} onExit={exitRoom} />
      }
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState<View>('lobby')
  const [alias] = useState(generateAlias)
  const [roomCode, setRoomCode] = useState('')
  const [roomHash, setRoomHash] = useState('')
  const [roomCreated, setRoomCreated] = useState(true)
  const [pickleKey, setPickleKey] = useState<string | null>(null)

  // No passphrase gate anymore — the device key is minted fresh for the
  // session, so a guest just taps "create" and walks in.
  useEffect(() => {
    let mounted = true
    void openDeviceKey().then(key => { if (mounted) setPickleKey(key) })
    return () => { mounted = false }
  }, [])

  // Enter a room while keeping the human code ONLY for display/copy. Every
  // byte that reaches the wire is the SHA-256 of the canonical code, so the
  // relay never sees a guessable secret.
  const enterRoom = useCallback(async (raw: string | null, isCreate: boolean) => {
    const canonical = raw && raw.trim() ? raw.trim().toUpperCase() : ''
    // Defense in depth: a join must hand us EXACTLY 18 hex digits (our
    // codes). Even if the lobby gate is somehow bypassed, never transition
    // from a lump of text. Create mints its own valid code instead.
    if (!isCreate && canonical && (!isValidCode(normalizeRoomCode(canonical)) || normalizeRoomCode(canonical).length !== 18)) {
      return
    }
    const code = canonical ? formatRoomCode(canonical.replace(/[^0-9A-F]/g, '')) : generateRoomCode()
    const key = normalizeRoomCode(code)
    setRoomCode(code)
    setRoomCreated(isCreate)
    setRoomHash(await hashRoomCode(key))
    const deviceKey = pickleKey ?? await openDeviceKey()
    setPickleKey(deviceKey)
    setView('room')
  }, [pickleKey])

  return (
    <E2eProvider
      relayUrl={RELAY_URL}
      roomCode={view === 'room' && pickleKey ? roomHash : ''}
      createRoom={roomCreated}
      pickleKey={pickleKey ?? ''}
    >
      <AppInner
        view={view}
        alias={alias}
        roomCode={roomCode}
        onCreateRoom={() => void enterRoom(null, true)}
        onJoinRoom={code => void enterRoom(code, false)}
        onExit={() => setView('lobby')}
      />
    </E2eProvider>
  )
}
