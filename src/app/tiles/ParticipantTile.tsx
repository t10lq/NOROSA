import { TileVideo } from './TileVideo'
import { SpeakerVideo } from './SpeakerVideo'
import type { SpeakerRouter } from '../../e2ee/speakerRouter'
import { aliasColor } from '../ui/aliasColor'
import { MicPath, SlashPath } from '../ui/icons'

export interface Participant {
  id: string; alias: string; muted: boolean; videoOff: boolean; speaking: boolean
  /** Inbound frames are actively failing to decrypt (client-side black video). */
  dropping: boolean
  /** Remote mix for a peer tile, or the local camera preview for 'self'. */
  stream: MediaStream | null
}

// ── Participant tile ──────────────────────────────────────────────
export function ParticipantTile({ p, large, router }: { p: Participant; large?: boolean; router?: SpeakerRouter }) {
  return (
    <div style={{
      position: 'relative', display: 'flex', alignItems: 'center',
      justifyContent: 'center', overflow: 'hidden',
      background: aliasColor(p.alias),
      border: p.speaking ? '1px solid rgba(240,238,233,0.28)' : '1px solid rgba(255,255,255,0.08)',
      borderRadius: '6px',
      transition: 'border-color 0.3s ease',
    }}>
      {p.id === 'self' || !router
        ? p.stream && <TileVideo stream={p.stream} mirrored={p.id === 'self'} muted={p.id === 'self'} />
        : <SpeakerVideo router={router} peer={p.id} stream={p.stream} />}
      {p.dropping && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(10,10,11,0.35)',
        }}>
          <span style={{
            fontFamily: "'Space Mono'", fontSize: 9, letterSpacing: '0.18em',
            color: 'rgba(240,238,233,0.85)', background: 'rgba(179,36,31,0.75)',
            padding: '4px 8px', borderRadius: 4, whiteSpace: 'nowrap',
          }}>DARK — DECRYPTING</span>
        </div>
      )}
      <span style={{
        fontFamily: "'Space Mono'", color: p.stream ? 'transparent' : 'rgba(240,238,233,0.45)',
        fontSize: large ? '2.2rem' : '1rem', letterSpacing: '0.06em', zIndex: 1, pointerEvents: 'none',
      }}>
        {p.alias.slice(0, 2).toUpperCase()}
      </span>
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: '38px',
        background: 'linear-gradient(to top, rgba(10,10,11,0.85) 0%, transparent 100%)',
        display: 'flex', alignItems: 'flex-end', padding: '0 12px 10px',
        gap: '6px', zIndex: 2,
      }}>
        {p.speaking && (
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#F0EEE9', flexShrink: 0, animation: 'breathe 1.4s ease infinite' }} />
        )}
        <span style={{ fontFamily: "'Space Mono'", fontSize: '10px', color: 'rgba(240,238,233,0.55)', letterSpacing: '0.07em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.alias}
        </span>
        {p.muted && (
          <svg style={{ marginLeft: 'auto', flexShrink: 0 }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#B3241F" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: MicPath + SlashPath }} />
        )}
      </div>
    </div>
  )
}