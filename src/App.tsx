import { useState, useEffect, useReducer, useRef, useCallback } from 'react'
import { HedgehogLogo } from './components/HedgehogLogo'
import { LoadingScreen } from './components/LoadingScreen'
import { RoomComponent } from './components/RoomComponent'
import { RoomReceiver } from './components/RoomReceiver'
import { E2eProvider, useE2e } from './context/E2eContext'
import { CallProvider, useCalls } from './context/CallContext'
import { getChatPeers, subscribeRoomChat } from './components/roomChat'
import { openDeviceKey } from './e2ee/vault'
import { formatRoomCode, generateRoomCode, hashRoomCode, isValidCode, normalizeRoomCode } from './e2ee/roomcode'
import { SpeakerRouter } from './e2ee/speakerRouter'
import { RELAY_URL } from './config/env'
import { generateAlias } from './app/ui/namegen'

const φ = 1.618033988749895

// ── Types ─────────────────────────────────────────────────────────
type View = 'lobby' | 'room'

import { MicPath, VidePath, SharePath, ChatPath, ExitPath, SlashPath, CopyPath, CheckPath, GearPath, SpeakerPath, EarPath } from './app/ui/icons'
import { useMediaQuery } from './app/ui/useMediaQuery'
import { Lobby } from './app/screens/Lobby'
import { Participant, ParticipantTile } from './app/tiles/ParticipantTile'

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

// ── Control button ────────────────────────────────────────────────
function Btn({ onClick, active = true, danger = false, title, pending = false, children }: {
  onClick: () => void; active?: boolean; danger?: boolean; title: string; pending?: boolean; children: React.ReactNode
}) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick} title={title}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      className="tap"
      style={{
        width: 46, height: 46, borderRadius: '10px', cursor: pending ? 'progress' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        touchAction: 'manipulation',
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



// ── Exit confirm ──────────────────────────────────────────────────
function ExitConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
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

// ── Settings modal ───────────────────────────────────────────────
interface AudioDeviceRowProps {
  label: string
  kind: 'in' | 'out' | 'cam'
  selected: boolean
  onSelect: () => void
  hint?: 'default' | 'ready' | 'blocked'
}

function AudioDeviceRow({ label, kind, selected, onSelect, hint }: AudioDeviceRowProps) {
  const [hov, setHov] = useState(false)
  const icon = kind === 'in' ? MicPath : kind === 'cam' ? VidePath : SpeakerPath
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
              ? (kind === 'cam' ? 'CAMERA PATH READY' : 'AUDIO PATH READY')
              : hint === 'blocked'
                ? (kind === 'cam' ? 'CAMERA BLOCKED' : 'MICROPHONE BLOCKED')
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

function SettingsModal({ open, onClose, input, output, camera, selIn, selOut, selCam, micHint, camHint, onSelectIn, onSelectOut, onSelectCam }: {
  open: boolean
  onClose: () => void
  input: MediaDeviceInfo[]
  output: MediaDeviceInfo[]
  camera: MediaDeviceInfo[]
  selIn: string
  selOut: string
  selCam: string
  micHint: 'idle' | 'ready' | 'blocked'
  camHint: 'idle' | 'ready' | 'blocked'
  onSelectIn: (id: string) => void
  onSelectOut: (id: string) => void
  onSelectCam: (id: string) => void
}) {
  const [tab, setTab] = useState<'out' | 'in' | 'cam'>('in')
  if (!open) return null

  const tabs = [
    { id: 'out' as const, label: 'OUTPUT', icon: SpeakerPath },
    { id: 'in' as const, label: 'INPUT', icon: MicPath },
    { id: 'cam' as const, label: 'CAMERA', icon: VidePath },
  ]

  const list = tab === 'out' ? output : tab === 'in' ? input : camera
  const sel = tab === 'out' ? selOut : tab === 'in' ? selIn : selCam
  const onSel = tab === 'out' ? onSelectOut : tab === 'in' ? onSelectIn : onSelectCam
  const hk = tab === 'in' ? micHint : tab === 'cam' ? camHint : 'idle'
  const hintRow = tab === 'out' ? undefined : (hk === 'ready' ? 'ready' as const : hk === 'blocked' ? 'blocked' as const : undefined)
  const emptyLabel = tab === 'out' ? 'output device' : tab === 'in' ? 'microphone' : 'camera'

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
            }}>NO {tab === 'out' ? 'OUTPUT' : tab === 'in' ? 'INPUT' : 'CAMERA'} FOUND</p>
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

// ── Room ──────────────────────────────────────────────────────────
function Room({ roomCode, alias, onExit }: { roomCode: string; alias: string; onExit: () => void }) {
  const { service } = useE2e()
  const calls = useCalls()
  const [sharing, setSharing] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [showExit, setShowExit] = useState(false)
  const [ctrlVis, setCtrlVis] = useState(true)
  const [copied, setCopied] = useState(false)
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sameDeviceTab, setSameDeviceTab] = useState(false)
  useEffect(() => {
    const poll = setInterval(() => {
      setSameDeviceTab(service?.sameDeviceDuplicateOpen() ?? false)
    }, 2000)
    setSameDeviceTab(service?.sameDeviceDuplicateOpen() ?? false)
    return () => clearInterval(poll)
  }, [service])
  const [mediaDevices, setMediaDevices] = useState<{ input: MediaDeviceInfo[]; output: MediaDeviceInfo[]; camera: MediaDeviceInfo[] }>({ input: [], output: [], camera: [] })
  const [selIn, setSelIn] = useState('default')
  const [selOut, setSelOut] = useState('default')
  const [selCam, setSelCam] = useState('default')
  const [micHint, setMicHint] = useState<'idle' | 'ready' | 'blocked'>('idle')
  const [camHint, setCamHint] = useState<'idle' | 'ready' | 'blocked'>('idle')
  const [, force] = useReducer(x => x + 1, 0)

  const isMobile = useMediaQuery('(max-width: 700px)')
  const speakerRouterRef = useRef<SpeakerRouter | null>(null)
  if (!speakerRouterRef.current) speakerRouterRef.current = new SpeakerRouter()
  const [speakerOn, setSpeakerOn] = useState(false)
  useEffect(() => () => speakerRouterRef.current?.reset(), [])
  const toggleSpeaker = () => {
    setSpeakerOn(on => {
      const next = !on
      speakerRouterRef.current?.setSpeaker(next)
      return next
    })
  }
  const selectOutput = (id: string) => {
    setSelOut(id)
    speakerRouterRef.current?.setOutputDevice(id)
  }

  useEffect(() => subscribeRoomChat(force), [])

  // One identity source: the relay-assigned connection alias. It is what the
  // other side's screen shows for us, so our own screen must agree with it.
  const selfName = service?.selfAlias ?? alias

  const muted = !calls.micOn
  const videoOff = !calls.camOn

  // Real grid: you + every device actually holding keys in this room. No
  // hardcoded guests — whoever is not really here does not render.
  const realPeers = getChatPeers()
  const all: Participant[] = [
    {
      id: 'self', alias: selfName, muted, videoOff, speaking: false, dropping: false,
      stream: calls.localCamera
        ? new MediaStream([calls.localCamera])
        : null,
    },
    ...realPeers.map(p => {
      const remote = calls.remoteStreams.get(p) ?? null
      return {
        id: `peer-${p}`, alias: p, muted: calls.peerMics.get(p) ?? false,
        videoOff: !remote || remote.getVideoTracks().length === 0,
        dropping: calls.decryptDrops.get(p) ?? false,
        speaking: false,
        stream: remote,
      } as Participant
    }),
  ]
  const cols = isMobile ? 1 : all.length <= 1 ? 1 : all.length <= 4 ? 2 : 3

  const nudge = useCallback(() => {
    setCtrlVis(true)
    if (hideRef.current) clearTimeout(hideRef.current)
    hideRef.current = setTimeout(() => setCtrlVis(false), 3800)
  }, [])

  useEffect(() => { nudge(); return () => { if (hideRef.current) clearTimeout(hideRef.current) } }, [nudge])
  // NOTE: browsers expose no API telling a page that it is being screen-
  // recorded, so a persistent "recording detected" banner cannot be honest.
  // Anti-leak protection instead comes from the watermark overlay below
  // (every captured frame carries alias + room code + clock) plus the
  // duplicate-tab screen. No timer fakes an alert.
  // The permission prompts fire here, once, on room entry: microphone first
  // (the call needs it the moment a peer is online). The camera is only
  // requested at first video toggle — a listening call should never have
  // silently grabbed the webcam. Denials surface as hints, not failures.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      let audioOk = false
      try {
        ;(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false })).getTracks().forEach(t => t.stop())
        audioOk = true
      } catch {
        // Rich constraints can fail with "Invalid constraint" on some engines.
        // A bare request is the real permission probe — try it before declaring
        // the mic blocked.
        try {
          ;(await navigator.mediaDevices.getUserMedia({ audio: true, video: false })).getTracks().forEach(t => t.stop())
          audioOk = true
        } catch {}
      }
      const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? []
      if (!cancelled) {
        setMediaDevices({
          input: all.filter(d => d.kind === 'audioinput'),
          output: all.filter(d => d.kind === 'audiooutput'),
          camera: all.filter(d => d.kind === 'videoinput'),
        })
        if (!audioOk) setMicHint('blocked')
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Auto re-detect devices whenever hardware state changes (headset plugged in,
  // Bluetooth reconnects, camera unplugged …) so new mics/cams/speakers appear
  // without a page reload.
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md?.addEventListener) return
    const onChange = () => {
      md.enumerateDevices().then(all => {
        setMediaDevices({
          input: all.filter(d => d.kind === 'audioinput'),
          output: all.filter(d => d.kind === 'audiooutput'),
          camera: all.filter(d => d.kind === 'videoinput'),
        })
      }).catch(() => {})
    }
    md.addEventListener('devicechange', onChange)
    return () => md.removeEventListener('devicechange', onChange)
  }, [])

  // Grant-blocked states discovered by the live call feed a clear hint.
  useEffect(() => {
    if (calls.micBlocked) setMicHint('blocked')
  }, [calls.micBlocked])
  useEffect(() => {
    if (calls.camBlocked) setCamHint('blocked')
  }, [calls.camBlocked])

  const selectInput = (id: string) => {
    setSelIn(id)
    if (id === 'default') { setMicHint('idle'); return }
    const exact = navigator.mediaDevices?.getUserMedia({ audio: { deviceId: { exact: id } }, video: false })
    if (!exact) { setMicHint('blocked'); return }
    exact
      .catch(() => navigator.mediaDevices!.getUserMedia({ audio: { deviceId: { ideal: id } }, video: false }))
      .then(ms => {
        ms.getTracks().forEach(t => t.stop())
        setMicHint('ready')
        calls.reconfigureDevices(id, null)
      })
      .catch(() => setMicHint('blocked'))
  }

  const selectCamera = (id: string) => {
    setSelCam(id)
    if (id === 'default') { setCamHint('idle'); return }
    const exact = navigator.mediaDevices?.getUserMedia({ video: { deviceId: { exact: id } }, audio: false })
    if (!exact) { setCamHint('blocked'); return }
    exact
      .catch(() => navigator.mediaDevices!.getUserMedia({ video: { deviceId: { ideal: id } }, audio: false }))
      .then(ms => {
        ms.getTracks().forEach(t => t.stop())
        setCamHint('ready')
        calls.reconfigureDevices(null, id)
      })
      .catch(() => setCamHint('blocked'))
  }

  const copyCode = () => {
    navigator.clipboard.writeText(roomCode).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div style={{ height: '100%', display: 'flex', background: '#0A0A0B', position: 'relative', overflow: 'hidden' }}
      onMouseMove={nudge}>

      {!calls.supported && (
        <div style={{
          position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 90,
          background: 'rgba(12,12,14,0.95)', border: '1px solid rgba(179,36,31,0.45)',
          borderRadius: 10, padding: '11px 18px', fontFamily: "'Space Mono'", fontSize: 11,
          letterSpacing: '0.05em', color: '#B3241F', backdropFilter: 'blur(20px)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)', whiteSpace: 'nowrap',
        }}>
          THIS BROWSER CANNOT RUN E2E MEDIA — CHAT ONLY
        </div>
      )}
      {!calls.supported && calls.supportReason && (
        <div style={{
          position: 'fixed', top: 96, left: '50%', transform: 'translateX(-50%)', zIndex: 90,
          background: 'rgba(12,12,14,0.9)', border: '1px solid rgba(179,36,31,0.3)',
          borderRadius: 8, padding: '7px 14px', fontFamily: "'Space Mono'", fontSize: 10,
          color: '#D98985', whiteSpace: 'nowrap', maxWidth: '90vw', overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {calls.supportReason}
        </div>
      )}
      {sameDeviceTab && (
        <div style={{
          position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 90,
          background: 'rgba(28,12,10,0.95)', border: '1px solid rgba(179,36,31,0.6)',
          borderRadius: 10, padding: '11px 18px', fontFamily: "'Space Mono'", fontSize: 11,
          letterSpacing: '0.05em', color: '#E5A2A0', backdropFilter: 'blur(20px)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)', whiteSpace: 'nowrap',
          textAlign: 'center', maxWidth: '85vw',
        }}>
          SECOND TAB OF THIS BROWSER DETECTED — SAME IDENTITY, MEDIA BETWEEN THEM STAYS BLACK
        </div>
      )}
      {showExit && <ExitConfirm onConfirm={onExit} onCancel={() => setShowExit(false)} />}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)}
        input={mediaDevices.input} output={mediaDevices.output} camera={mediaDevices.camera}
        selIn={selIn} selOut={selOut} selCam={selCam} micHint={micHint} camHint={camHint}
        onSelectIn={selectInput} onSelectOut={selectOutput} onSelectCam={selectCamera} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Always-on group crypto pipeline — chat may be hidden */}
        <RoomReceiver />

        {/* Header */}
        <div style={{
          height: isMobile ? 'auto' : 55,
          minHeight: isMobile ? 52 : 55,
          display: 'flex', alignItems: 'center',
          padding: isMobile ? 'calc(8px + env(safe-area-inset-top)) 12px 8px' : '0 20px',
          gap: isMobile ? 8 : 16,
          background: 'rgba(10,10,11,0.75)', backdropFilter: 'blur(16px)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          position: 'relative', zIndex: 10,
          opacity: ctrlVis ? 1 : 0, transition: 'opacity 0.5s ease',
          pointerEvents: ctrlVis ? 'auto' : 'none',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <HedgehogLogo size={20} />
            <span style={{ fontFamily: "'Space Mono'", fontSize: 13, letterSpacing: '0.2em', color: '#F0EEE9' }}>Norosa</span>
          </span>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 16 }}>
            {!isMobile && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'rgba(240,238,233,0.3)', animation: 'breathe 3s ease infinite' }} />
                <span style={{ fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.08em', color: '#3A3A3F' }}>E2E ENCRYPTED</span>
              </div>
            )}
            <span style={{ fontFamily: "'Space Mono'", fontSize: 10, color: '#3A3A3F', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '38vw' }}>{selfName}</span>
          </div>
        </div>

        {/* Video grid */}
        <div style={{
          flex: 1, display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridAutoRows: '1fr',
          gap: '2px', padding: '2px', background: '#060606',
          position: 'relative',
        }}>
          {all.map(p => <ParticipantTile key={p.id} p={p} large={all.length === 1} router={speakerRouterRef.current ?? undefined} />)}
          {/* Leak watermark — every recorded/captured frame is traceable to this
              identity, room and moment. True "is it being recorded?" detection is
              not exposed to web pages, so we mark instead of guess. */}
          <div style={{
            position: 'absolute', right: 12, bottom: 10, zIndex: 5, pointerEvents: 'none', userSelect: 'none',
            fontFamily: "'Space Mono'", fontSize: 9, letterSpacing: '0.12em',
            color: 'rgba(240,238,233,0.18)', opacity: 0.75,
          }}>
            {selfName} · {roomCode} · {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        {/* Capture in flight — instant feedback for the camera button */}
        {(calls.camPending || calls.micPending) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
            background: 'rgba(30,30,36,0.6)', border: '1px solid rgba(255,255,255,0.12)',
            fontSize: 11, fontFamily: "'Space Mono'", letterSpacing: '0.06em', color: 'rgba(240,238,233,0.8)',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#F0EEE9', animation: 'breathe 0.9s ease infinite' }} />
            {calls.camPending ? 'ENABLING CAMERA — check for the permission prompt…' : 'ENABLING MICROPHONE…'}
          </div>
        )}

        {/* Device failures — the button must never fail silently */}
        {(calls.micError || calls.camError) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
            background: 'rgba(120,40,35,0.55)', border: '1px solid rgba(255,90,80,0.35)',
            fontSize: 11, fontFamily: "'Space Mono'", letterSpacing: '0.06em', color: '#FFB4AB',
          }}>
            <span style={{ flex: 1 }}>
              {calls.camError
                ? `CAMERA BLOCKED · ${calls.camError}`
                : `MIC BLOCKED · ${calls.micError}`}
              <span style={{ opacity: 0.7 }}> — allow access for this site, then: </span>
            </span>
            {calls.camError && (
              <button onClick={() => calls.setCamOn(true, selCam !== 'default' ? selCam : undefined)}
                style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)', color: '#F0EEE9', padding: '3px 10px', fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.08em', cursor: 'pointer' }}>
                RETRY CAMERA
              </button>
            )}
            {calls.micError && (
              <button onClick={calls.toggleMic}
                style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)', color: '#F0EEE9', padding: '3px 10px', fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.08em', cursor: 'pointer' }}>
                RETRY MIC
              </button>
            )}
          </div>
        )}

        {/* Controls */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          height: isMobile ? undefined : 88,
          minHeight: isMobile ? undefined : 88,
          padding: isMobile ? '10px 8px calc(10px + env(safe-area-inset-bottom))' : '0',
          flexWrap: isMobile ? 'wrap' : undefined,
          rowGap: isMobile ? 10 : undefined,
          background: 'rgba(10,10,11,0.82)', backdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          opacity: ctrlVis ? 1 : 0.1, transition: 'opacity 0.5s ease',
        }}>
          <Btn onClick={calls.toggleMic} active={!muted} pending={calls.micPending} title={muted ? 'Unmute' : 'Mute'}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: MicPath + (muted ? SlashPath : '') }} />
          </Btn>
          <Btn onClick={() => calls.setCamOn(!videoOff, selCam !== 'default' ? selCam : undefined)} active={!videoOff && !calls.camBlocked} pending={calls.camPending || (calls.camOn && !calls.localCamera)} title={videoOff ? 'Enable video' : 'Disable video'}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: VidePath + (videoOff ? SlashPath : '') }} />
          </Btn>
          <Btn onClick={toggleSpeaker} active={speakerOn} title={speakerOn ? 'Speakerphone — tap for earpiece' : 'Earpiece — tap for speakerphone'}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: speakerOn ? SpeakerPath : EarPath }} />
          </Btn>
          <Btn onClick={() => setSharing(s => !s)} active={sharing} title={sharing ? 'Stop sharing' : 'Share screen'}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: SharePath }} />
          </Btn>
          <Btn onClick={() => setChatOpen(c => !c)} active={chatOpen} title="Chat">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: ChatPath }} />
          </Btn>
          {!isMobile && (
            <Btn onClick={() => setSettingsOpen(true)} active title="Audio settings">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                dangerouslySetInnerHTML={{ __html: GearPath }} />
            </Btn>
          )}
          <Btn onClick={copyCode} active={!copied} title={copied ? 'Room code copied' : 'Copy room code — the relay only ever sees its SHA-256 hash'}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: copied ? CheckPath : CopyPath }} />
          </Btn>
          <div style={{ width: 1, height: 32, background: 'rgba(255,255,255,0.10)', margin: '0 4px' }} />
          <Btn onClick={() => setShowExit(true)} danger title="Exit room">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: ExitPath }} />
          </Btn>
        </div>
      </div>

      {chatOpen && (
        isMobile ? (
          <div onClick={() => setChatOpen(false)}
            style={{
              position: 'absolute', inset: 0, zIndex: 60, display: 'flex',
              background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)',
              paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
            }}>
            <div onClick={e => e.stopPropagation()} style={{ flex: 1, minWidth: 0, display: 'flex' }}>
              <RoomComponent userId={alias} onClose={() => setChatOpen(false)} />
            </div>
          </div>
        ) : (
          <RoomComponent userId={alias} />
        )
      )}

      <style>{`
        @keyframes slideInRight { from { opacity:0; transform:translateX(20px) } to { opacity:1; transform:translateX(0) } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes scaleIn { from { opacity:0; transform:scale(0.95) } to { opacity:1; transform:scale(1) } }
        @keyframes breathe { 0%,100%{opacity:0.3} 50%{opacity:0.9} }
      `}</style>
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
