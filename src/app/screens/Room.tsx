import { useState, useEffect, useReducer, useRef, useCallback } from 'react'
import { HedgehogLogo } from '../components/HedgehogLogo'
import { RoomComponent } from './room/RoomComponent'
import { RoomReceiver } from './room/RoomReceiver'
import { useE2e } from '../../context/E2eContext'
import { useCalls } from '../../context/CallContext'
import { getChatPeers, subscribeRoomChat } from '../../store/roomChat'
import { SpeakerRouter } from '../../media/speakerRouter'
import { MicPath, ChatPath, ExitPath, SlashPath, CopyPath, CheckPath, GearPath, SpeakerPath, EarPath } from '../ui/icons'
import { useMediaQuery } from '../ui/useMediaQuery'
import { Btn } from '../controls/Btn'
import { ExitConfirm } from '../controls/ExitConfirm'
import { SettingsModal } from '../controls/SettingsModal'
import { Participant, ParticipantTile } from '../tiles/ParticipantTile'

// ── Room ──────────────────────────────────────────────────────────
export function Room({ roomCode, alias, onExit }: { roomCode: string; alias: string; onExit: () => void }) {
  const { service } = useE2e()
  const calls = useCalls()
  const [chatOpen, setChatOpen] = useState(false)
  const [showExit, setShowExit] = useState(false)
  const [ctrlVis, setCtrlVis] = useState(true)
  const [copied, setCopied] = useState(false)
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [diagOpen, setDiagOpen] = useState(false)
  const [sameDeviceTab, setSameDeviceTab] = useState(false)
  useEffect(() => {
    const poll = setInterval(() => {
      setSameDeviceTab(service?.sameDeviceDuplicateOpen() ?? false)
    }, 2000)
    setSameDeviceTab(service?.sameDeviceDuplicateOpen() ?? false)
    return () => clearInterval(poll)
  }, [service])
  const [mediaDevices, setMediaDevices] = useState<{ input: MediaDeviceInfo[]; output: MediaDeviceInfo[] }>({ input: [], output: [] })
  const [selIn, setSelIn] = useState('default')
  const [selOut, setSelOut] = useState('default')
  const [micHint, setMicHint] = useState<'idle' | 'ready' | 'blocked'>('idle')
  const [, force] = useReducer(x => x + 1, 0)

  const isMobile = useMediaQuery('(max-width: 700px)')
  const isTouch = useMediaQuery('(hover: none) and (pointer: coarse)')
  const speakerRouterRef = useRef<SpeakerRouter | null>(null)
  if (!speakerRouterRef.current) speakerRouterRef.current = new SpeakerRouter()
  const callsRef = useRef(calls)
  callsRef.current = calls
  // iOS/Android refuse unmuted play() outside a user gesture — re-run it on
  // the first pointer/touch/key so remote audio actually starts on phones.
  // The same gesture re-requests the microphone: iOS silently denies a
  // getUserMedia fired outside a user activation, which left phones with a
  // working speaker but a dead mic (PC never hears them) until the user found
  // the RETRY button or iOS Settings. Inside the handler both are legal.
  const unlockedRef = useRef(false)
  useEffect(() => {
    const unlock = () => {
      unlockedRef.current = true
      speakerRouterRef.current?.unlock()
      const c = callsRef.current
      if (c.micBlocked && !c.micPending) void c.setMicOn(true)
    }
    const evs = ['pointerdown', 'touchstart', 'keydown', 'click'] as const
    for (const ev of evs) window.addEventListener(ev, unlock, { once: true, passive: true })
    const t = setTimeout(() => speakerRouterRef.current?.unlock(), 2500)
    return () => {
      for (const ev of evs) window.removeEventListener(ev, unlock)
      clearTimeout(t)
    }
  }, [])
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

  // Real grid: you + every device actually holding keys in this room. No
  // hardcoded guests — whoever is not really here does not render.
  const realPeers = getChatPeers()
  // Audio-only session — no local video preview; remote tiles show initials.
  const all: Participant[] = [
    {
      id: 'self', alias: selfName, muted,
      speaking: false, dropping: false,
      stream: null,
    },
    ...realPeers.map(p => {
      const remote = calls.remoteStreams.get(p) ?? null
      return {
        id: `peer-${p}`, alias: p, muted: calls.peerMics.get(p) ?? false,
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
  // The permission prompt fires here, once, on room entry: microphone (the
  // call needs it the moment a peer is online). Denials surface as a hint,
  // not a failure.
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
        calls.reconfigureDevices(id)
      })
      .catch(() => setMicHint('blocked'))
  }

  const copyCode = () => {
    navigator.clipboard.writeText(roomCode).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div style={{ height: '100%', display: 'flex', background: '#0A0A0B', position: 'relative', overflow: 'hidden' }}
      onMouseMove={nudge}>

      {calls.supported === false && (
        <div style={{
          position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 90,
          background: 'rgba(20,16,8,0.95)', border: '1px solid rgba(201,150,60,0.5)',
          borderRadius: 10, padding: '11px 18px', fontFamily: "'Space Mono'", fontSize: 11,
          letterSpacing: '0.05em', color: '#E5B052', backdropFilter: 'blur(20px)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)', whiteSpace: 'nowrap',
        }}>
          ENCRYPTED · DTLS-SRTP MODE — THIS BROWSER LACKS THE E2EE TRANSFORM LAYER
        </div>
      )}
      {calls.cryptoMode === 'mixed' && calls.supported && (
        <div style={{
          position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 90,
          background: 'rgba(20,16,8,0.95)', border: '1px solid rgba(201,150,60,0.5)',
          borderRadius: 10, padding: '11px 18px', fontFamily: "'Space Mono'", fontSize: 11,
          letterSpacing: '0.05em', color: '#E5B052', backdropFilter: 'blur(20px)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)', whiteSpace: 'nowrap', maxWidth: '85vw',
        }}>
          A PEER LACKS THE E2EE TRANSFORM LAYER — ITS AUDIO LINK RUNS ON DTLS-SRTP
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
        input={mediaDevices.input} output={mediaDevices.output}
        selIn={selIn} selOut={selOut} micHint={micHint}
        onSelectIn={selectInput} onSelectOut={selectOutput} />

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
                <span style={{ fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.08em', color: '#3A3A3F' }}>{calls.cryptoMode === 'e2ee' ? 'E2E ENCRYPTED' : 'DTLS-SRTP ENCRYPTED'}</span>
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
            position: 'absolute', right: 12,
            bottom: 10, zIndex: 4, pointerEvents: 'none', userSelect: 'none',
            fontFamily: "'Space Mono'", fontSize: 9, letterSpacing: '0.12em',
            color: 'rgba(240,238,233,0.18)', opacity: 0.75,
          }}>
            {selfName} · {roomCode} · {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        {/* Capture in flight — instant feedback for the mic button */}
        {calls.micPending && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
            background: 'rgba(30,30,36,0.6)', border: '1px solid rgba(255,255,255,0.12)',
            fontSize: 11, fontFamily: "'Space Mono'", letterSpacing: '0.06em', color: 'rgba(240,238,233,0.8)',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#F0EEE9', animation: 'breathe 0.9s ease infinite' }} />
            ENABLING MICROPHONE…
          </div>
        )}

        {/* Device failures — the button must never fail silently */}
        {calls.micError && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
            background: 'rgba(120,40,35,0.55)', border: '1px solid rgba(255,90,80,0.35)',
            fontSize: 11, fontFamily: "'Space Mono'", letterSpacing: '0.06em', color: '#FFB4AB',
          }}>
            <span style={{ flex: 1 }}>
              MIC BLOCKED · {calls.micError}
              <span style={{ opacity: 0.7 }}> — allow access for this site, then: </span>
            </span>
            <button onClick={calls.toggleMic}
              style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)', color: '#F0EEE9', padding: '3px 10px', fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.08em', cursor: 'pointer' }}>
              RETRY MIC
            </button>
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
          {isTouch && (
            <Btn onClick={toggleSpeaker} active={speakerOn} title={speakerOn ? 'Speakerphone — tap for earpiece' : 'Earpiece — tap for speakerphone'}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                dangerouslySetInnerHTML={{ __html: speakerOn ? SpeakerPath : EarPath }} />
            </Btn>
          )}
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

      {/* Live media diagnostics — one tap, no devtools. Every row is that
          peer's audio link FROM THIS device's perspective: ↑ = packets we
          sent to them, ↓ = packets we received from them. A constant-0 here
          names the broken half instantly (see the dir / tx / rx columns). */}
      {!diagOpen ? (
        <button onClick={() => setDiagOpen(true)}
          style={{
            position: 'fixed', left: 10, bottom: isMobile ? 100 : 12, zIndex: 70,
            background: 'rgba(10,10,11,0.85)', border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 8, color: '#6E6E77', fontFamily: "'Space Mono'", fontSize: 10,
            letterSpacing: '0.08em', padding: '5px 9px', cursor: 'pointer',
            backdropFilter: 'blur(12px)',
          }}>
          MEDIA ⓘ
        </button>
      ) : (
        <div style={{
          position: 'fixed', left: 10, bottom: isMobile ? 100 : 12, zIndex: 70,
          background: 'rgba(8,8,10,0.94)', border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 10, padding: 10, fontFamily: "'Space Mono'", fontSize: 9,
          color: '#8B8B96', lineHeight: '15px', maxWidth: '92vw',
          boxShadow: '0 10px 40px rgba(0,0,0,0.7)', backdropFilter: 'blur(12px)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <b style={{ color: '#C9C9D4', letterSpacing: '0.06em' }}>MEDIA LIVE</b>
            <button onClick={() => setDiagOpen(false)} style={{ background: 'none', border: 'none', color: '#6E6E77', cursor: 'pointer', fontFamily: "'Space Mono'", fontSize: 10 }}>✕</button>
          </div>
          <div style={{ opacity: 0.55 }}>ME {selfName} · ROOM {roomCode} · {calls.micOn ? 'mic ON' : 'mic OFF'}{calls.micBlocked ? ' (BLOCKED)' : ''} · {calls.supported ? 'E2EE-capable' : 'DTLS-SRTP-only'} · {calls.cryptoMode.toUpperCase()}</div>
          {[...calls.peerStats.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([peer, s]) => (
            <div key={peer} style={{ whiteSpace: 'nowrap' }}>
              <span style={{ color: '#D7D7E0' }}>{peer.slice(0, 10)}</span>
              <span> {s.conn === 'connected' ? 'CONN' : s.conn.toUpperCase()} {s.sig.slice(0, 4)}</span>
              <span style={{ color: s.dir === 'sendrecv' ? '#7BD88F' : '#E5A24A' }}>{s.dir === 'sendrecv' ? 'SD' : (s.dir || '?').toUpperCase()}/{s.rdir === 'sendrecv' ? 'SD' : (s.rdir || '?').toUpperCase()}</span>
              <span> ↑{s.packetsSent} · ↓{s.packetsReceived}</span>
              <span style={{ color: s.hasMic ? '#7BD88F' : '#8B8B96' }}>{s.hasMic ? ' M+' : ' M-'}</span>
              <span style={{ color: s.txAttached ? '#7BD88F' : '#8B8B96' }}>{s.txAttached ? ' TX:e2ee' : ' TX:--'}</span>
              <span style={{ color: s.rxAttached ? '#7BD88F' : '#8B8B96' }}>{s.rxAttached ? ' RX:e2ee' : ' RX:--'}</span>
              {s.decryptFailing && <span style={{ color: '#FF6B5E' }}> DROPS!</span>}
              <span> {s.rttMs != null ? `${s.rttMs}ms` : ''}</span>
              <span style={{ color: (s.trDir ?? '').includes('send') ? '#7BD88F' : '#E5A24A' }}> tr:{s.trDir ?? '?'}</span>
              <span style={{ opacity: 0.7 }}> aTr:{s.aTr}</span>
              <span style={{ opacity: 0.7 }}> mk:{s.sLive ?? 'x'}</span>
            </div>
          ))}
          <div style={{ opacity: 0.5, marginTop: 4 }}>dir = MY m-line / THEIR m-line · SD/MY+THEIR · tr = sender transceiver direction (must include 'send' or ↑ stays 0) · aTr = audio transceiver count · mk = mic readyState on sender</div>
          <div style={{ opacity: 0.75, marginTop: 3, borderTop: '1px solid rgba(255,255,255,0.10)', paddingTop: 3 }}>
            {calls.actionLog.map((n, i) => (
              <div key={i} style={{ color: n.includes('fail') || n.includes('dup') ? '#ff8a8a' : '#ffd98a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{n}</div>
            ))}
            {calls.frameTele.notes.map((n, i) => (
              <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{n}</div>
            ))}
            {[...new Set([...calls.frameTele.delivered.keys(), ...calls.frameTele.dropped.keys()])].sort().map(p => (
              <div key={p}>RFM {p.slice(0, 9)}: DEL {calls.frameTele.delivered.get(p) ?? 0} · DROP {calls.frameTele.dropped.get(p) ?? 0}</div>
            ))}
          </div>
        </div>
      )}

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