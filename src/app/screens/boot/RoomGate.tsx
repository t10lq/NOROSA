import { useE2e } from '../../../context/E2eContext'
import { CallProvider } from '../../../context/CallContext'
import { Room } from '../Room'
import { JoinRejected } from './JoinRejected'
import { BootFailure } from './BootFailure'
import { RoomBootLoader } from './RoomBootLoader'

// ── Room gate ─────────────────────────────────────────────────────
// The room UI must NEVER mount unless the relay actually accepted us and the
// crypto engine is ready. Until then the user sees a boot loader; a refused
// join shows a plain rejection screen — no grid, no controls, no "room".
export function RoomGate({ roomCode, alias, onExit }: { roomCode: string; alias: string; onExit: () => void }) {
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