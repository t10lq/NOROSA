import { useState, useEffect, useCallback } from 'react'
import { LoadingScreen } from './app/components/LoadingScreen'
import { E2eProvider } from './context/E2eContext'
import { openDeviceKey } from './crypto/vault'
import { formatRoomCode, generateRoomCode, hashRoomCode, isValidCode, normalizeRoomCode } from './e2ee/roomcode'
import { RELAY_URL } from './config/env'
import { generateAlias } from './app/ui/namegen'
import { Lobby } from './app/screens/Lobby'
import { RoomGate } from './app/screens/boot/RoomGate'

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

// ── App inner ─────────────────────────────────────────────────────
function AppInner({ view, alias, roomCode, onCreateRoom, onJoinRoom, onExit }: {
  view: View
  alias: string
  roomCode: string
  onCreateRoom: () => void
  onJoinRoom: (code: string) => void
  onExit: () => void
}) {
  const [progress] = useState(0)
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
