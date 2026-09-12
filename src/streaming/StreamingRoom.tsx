import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioMixer } from './audioMixer'

export type StreamRole = 'host' | 'viewer'

/**
 * StreamingRoom — the norosa broadcasting dashboard.
 *
 * Mount anywhere with a single import; nothing else in the app is touched.
 * The media surface is fully self-managed: screen+system-audio capture,
 * microphone streaming, Web-Audio blending, viewer-side feedback prevention,
 * fullscreen stage, 0–100 output volume, and self-healing alerts. Delivery of
 * the resulting streams to a real audience is wired by the integration hooks:
 *
 *  - onStartBroadcast(out)   host starts → give `out` to your signaling/SFU
 *  - onStopBroadcast(out)    host stops  → tear down the upstream
 *  - onViewStart()           viewer clicks "View Stream" → negotiate with the
 *                            host and RESOLVE with the downstream MediaStream
 *                            (omit it to run a local demo tone instead)
 *  - onViewEnd(remote)       viewer leaves → your signaling cleans up
 *
 * Without hooks the room still runs end-to-end locally (capture → mix →
 * preview → volume), so every control is verifiable in one tab.
 */
export interface StreamingRoomProps {
  brand?: string
  sessionTitle?: string
  /** Audience size surfaced by the integrator (lives in the header). */
  audience?: number
  onStartBroadcast?: (out: MediaStream) => void | Promise<void>
  onStopBroadcast?: (out: MediaStream) => void | Promise<void>
  onViewStart?: () => Promise<MediaStream>
  onViewEnd?: (remote: MediaStream) => void | Promise<void>
  onRoleChange?: (role: StreamRole) => void
}

type AlertKind = 'permission' | 'device' | 'system' | 'info'

interface AlertItem {
  id: string
  kind: AlertKind
  title: string
  detail: string
  persistent: boolean
  retry?: () => void
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
const pad2 = (n: number): string => String(n).padStart(2, '0')

const classifyMediaError = (e: unknown): { kind: AlertKind; title: string; message: string } => {
  const err = e as { name?: string; message?: string } | null
  const name = err?.name ?? ''
  const msg = err?.message ?? 'Unknown capture error'
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return { kind: 'permission', title: 'ACCESS DENIED', message: 'A media permission was refused. Allow this site access in the address bar, then try again.' }
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { kind: 'device', title: 'DEVICE NOT FOUND', message: 'No matching microphone or screen source. Plug one in or re-check the browser picker.' }
  }
  if (name === 'AbortError') {
    return { kind: 'system', title: 'CAPTURE INTERRUPTED', message: 'The capture failed mid-flight — a transient glitch. Retrying automatically.' }
  }
  if (name === 'SecurityError' || name === 'NotSupportedError') {
    return { kind: 'device', title: 'MEDIA UNAVAILABLE', message: 'Screen capture needs HTTPS/localhost and a Chromium-family browser. ' + msg }
  }
  return { kind: 'system', title: 'CAPTURE FAILED', message: msg }
}

const Icon = ({ d, size = 16, className }: { d: string; size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
    strokeLinecap="round" strokeLinejoin="round" className={className} dangerouslySetInnerHTML={{ __html: d }} />
)

const P = {
  mic: '<path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/>',
  micOff: '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>',
  screen: '<path d="M10 7.75a.75.75 0 0 1 1.142-.638l3.664 2.25a.75.75 0 0 1 0 1.276l-3.664 2.25a.75.75 0 0 1-1.142-.638Z"/><path d="M12 17v4"/><path d="M8 21h8"/><rect x="2" y="3" width="20" height="14" rx="2"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  compress: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  stop: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  live: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  refresh: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/>',
  vol: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  volX: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" x2="17" y1="9" y2="15"/><line x1="17" x2="23" y1="9" y2="15"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
}

const BrandMark = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="4" stroke="#2EF2AB" strokeWidth="1.6" fill="#2EF2AB" fillOpacity="0.18" />
    <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#818CF8" strokeWidth="1.3" transform="rotate(-20 12 12)" opacity="0.9" />
    <circle cx="21.5" cy="4.6" r="1.4" fill="#2EF2AB" />
  </svg>
)

const fmt = (s: number): string => `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`

export function StreamingRoom({
  brand = 'norosa',
  sessionTitle = 'Live Studio',
  audience = 0,
  onStartBroadcast,
  onStopBroadcast,
  onViewStart,
  onViewEnd,
  onRoleChange,
}: StreamingRoomProps) {
  const [role, setRole] = useState<StreamRole>('host')
  const [phase, setPhase] = useState<'idle' | 'starting' | 'live'>('idle')
  const [viewPhase, setViewPhase] = useState<'idle' | 'connecting' | 'viewing'>('idle')
  const [micOn, setMicOn] = useState(true)
  const [sysOn, setSysOn] = useState(true)
  const [vol, setVol] = useState(65)
  const [muted, setMuted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [isFs, setIsFs] = useState(false)
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [bars, setBars] = useState<number[]>([0, 0, 0, 0, 0])
  const [busy, setBusy] = useState(false)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef<HTMLVideoElement | null>(null)
  const viewerRef = useRef<HTMLVideoElement | null>(null)
  const mixerRef = useRef<AudioMixer | null>(null)
  const displayRef = useRef<MediaStream | null>(null)
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  const sysTrackRef = useRef<MediaStreamTrack | null>(null)
  const broadcastRef = useRef<MediaStream | null>(null)
  const remoteRef = useRef<MediaStream | null>(null)
  const demoRef = useRef<{ ctx: AudioContext; osc: OscillatorNode; gain: GainNode } | null>(null)
  const stepRef = useRef(0)
  const mountedRef = useRef(true)
  const stopBroadcastRef = useRef<() => void>(() => {})

  useEffect(() => {
    stopBroadcastRef.current = () => void stopBroadcast()
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stepRef.current++
      try {
        displayRef.current?.getTracks().forEach(t => t.stop())
        micTrackRef.current?.stop()
        sysTrackRef.current?.stop()
        mixerRef.current?.close()
        if (demoRef.current) {
          demoRef.current.osc.stop()
          void demoRef.current.ctx.close()
        }
        remoteRef.current?.getTracks().forEach(t => t.stop())
        if (document.fullscreenElement) void document.exitFullscreen()
      } catch {
        /* unmount teardown is best-effort */
      }
    }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  useEffect(() => {
    if (!navigator.mediaDevices) {
      pushAlert('device', 'MEDIA API UNSUPPORTED', 'navigator.mediaDevices is unavailable — run over HTTPS or localhost.', true)
    } else if (!navigator.mediaDevices.getDisplayMedia) {
      pushAlert('device', 'SCREEN SHARE UNSUPPORTED', 'This browser has no getDisplayMedia. Use a Chromium-family browser for broadcasting.', true)
    }
  }, [])

  const pushAlert = useCallback((kind: AlertKind, title: string, detail: string, persistent = false, retry?: () => void) => {
    const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setAlerts(prev => [...prev.slice(-3), { id, kind, title, detail, persistent, retry }])
    if (!persistent) {
      setTimeout(() => setAlerts(a => a.filter(x => x.id !== id)), 7000)
    }
  }, [])

  const dropAlert = (id: string): void => {
    setAlerts(a => a.filter(x => x.id !== id))
  }

  const applyVolume = (level: number, mute: boolean): void => {
    const effective = mute ? 0 : clamp(level, 0, 100) / 100
    mixerRef.current?.setVolume(effective)
    if (viewerRef.current) viewerRef.current.volume = effective
  }

  const acquireMic = useCallback(async (): Promise<MediaStreamTrack | null> => {
    const stream = await navigator.mediaDevices!.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const track = stream.getAudioTracks()[0] ?? null
    if (!track) return null
    micTrackRef.current = track
    track.addEventListener('ended', () => {
      micTrackRef.current = null
      mixerRef.current?.removeSource('mic')
      setMicOn(false)
      pushAlert('system', 'MICROPHONE STOPPED', 'The mic was cut off by the system. Re-enable it from the audio panel.', true)
    })
    return track
  }, [pushAlert])

  const acquireDisplay = useCallback(async (): Promise<{ video: MediaStreamTrack | null; system: MediaStreamTrack | null }> => {
    const stream = await navigator.mediaDevices!.getDisplayMedia({
      video: { frameRate: 60 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    displayRef.current = stream
    const video = stream.getVideoTracks()[0] ?? null
    const system = stream.getAudioTracks()[0] ?? null
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      stopBroadcastRef.current()
      pushAlert('system', 'SCREEN SHARE ENDED', 'The browser closed the share. Broadcast stopped cleanly; start again to resume.', false)
    })
    return { video, system }
  }, [pushAlert])

  const teardownLocal = useCallback((): void => {
    displayRef.current?.getTracks().forEach(t => t.stop())
    displayRef.current = null
    micTrackRef.current?.stop()
    micTrackRef.current = null
    sysTrackRef.current?.stop()
    sysTrackRef.current = null
    mixerRef.current?.close()
    mixerRef.current = null
    broadcastRef.current = null
  }, [])

  const beginBroadcast = useCallback(async (): Promise<void> => {
    if (phase === 'starting' || phase === 'live' || busy) return
    setPhase('starting')
    setBusy(true)
    const step = ++stepRef.current
    try {
      if (!AudioMixer.isSupported()) throw new Error('Web Audio is not supported in this browser')
      mixerRef.current = AudioMixer.create()
      if (!mixerRef.current) throw new Error('Web Audio context could not be created')
      await mixerRef.current.prime()
      void applyVolume(vol, muted)

      const { video, system } = await acquireDisplay()
      if (system) sysTrackRef.current = system
      if (system && sysOn) mixerRef.current.addSource('system', system)

      if (micOn) {
        try {
          const mic = await acquireMic()
          if (mic) mixerRef.current!.addSource('mic', mic)
        } catch (e) {
          const c = classifyMediaError(e)
          pushAlert(c.kind, c.title, `${c.message} Continuing with screen audio only.`, true)
        }
      }

      if (step !== stepRef.current) return
      const out = new MediaStream()
      if (video) out.addTrack(video)
      out.addTrack(mixerRef.current.outputTrack)
      broadcastRef.current = out
      setPhase('live')
      await onStartBroadcast?.(out)
    } catch (e) {
      const c = classifyMediaError(e)
      if (c.kind === 'system' && c.title === 'CAPTURE INTERRUPTED') {
        pushAlert(c.kind, c.title, 'Retrying automatically…', false)
        setTimeout(() => void beginBroadcast(), 900)
        return
      }
      teardownLocal()
      pushAlert(c.kind, c.title, c.message, true, () => void beginBroadcast())
    } finally {
      setPhase(p => (p === 'starting' ? 'idle' : p))
      setBusy(false)
    }
  }, [phase, busy, vol, muted, sysOn, micOn, acquireDisplay, acquireMic, teardownLocal, pushAlert, onStartBroadcast])

  const stopBroadcast = useCallback(async (): Promise<void> => {
    if (phase === 'idle') { teardownLocal(); return }
    const out = broadcastRef.current
    setPhase('idle')
    teardownLocal()
    await onStopBroadcast?.(out!)
  }, [phase, teardownLocal, onStopBroadcast])

  const toggleMic = useCallback(async (): Promise<void> => {
    if (phase !== 'live' || !mixerRef.current) {
      setMicOn(v => !v)
      return
    }
    if (micOn) {
      mixerRef.current.removeSource('mic')
      micTrackRef.current?.stop()
      micTrackRef.current = null
      setMicOn(false)
    } else {
      try {
        const mic = await acquireMic()
        if (mic) mixerRef.current!.addSource('mic', mic)
        setMicOn(true)
      } catch (e) {
        const c = classifyMediaError(e)
        pushAlert(c.kind, c.title, c.message, true, () => void toggleMic())
      }
    }
  }, [phase, micOn, acquireMic, pushAlert])

  const toggleSys = useCallback((): void => {
    if (phase !== 'live' || !mixerRef.current) {
      setSysOn(v => !v)
      return
    }
    if (sysOn) {
      mixerRef.current.removeSource('system')
      setSysOn(false)
    } else {
      if (!sysTrackRef.current) {
        pushAlert('system', 'SYSTEM AUDIO UNAVAILABLE', 'This screen source carries no audio. Stop sharing and re-capture with the "Share system audio" box ticked.', true)
        return
      }
      mixerRef.current.addSource('system', sysTrackRef.current)
      setSysOn(true)
    }
  }, [phase, sysOn, pushAlert])

  const stopViewing = useCallback(async (): Promise<void> => {
    const remote = remoteRef.current
    stepRef.current++
    if (demoRef.current) {
      try {
        demoRef.current.osc.stop()
        void demoRef.current.ctx.close()
      } catch {
        /* demo teardown */
      }
      demoRef.current = null
    }
    if (viewerRef.current) viewerRef.current.srcObject = null
    remote?.getTracks().forEach(t => { try { t.stop() } catch { /* best-effort */ } })
    remoteRef.current = null
    setViewPhase('idle')
    if (remote) await onViewEnd?.(remote)
  }, [onViewEnd])

  const beginViewing = useCallback(async (): Promise<void> => {
    if (viewPhase !== 'idle') return
    stepRef.current++
    teardownLocal()
    setViewPhase('connecting')
    try {
      let remote: MediaStream | null = null
      if (onViewStart) {
        remote = await onViewStart()
      } else {
        const ac = new AudioContext()
        const osc = ac.createOscillator()
        osc.frequency.value = 220
        const gain = ac.createGain()
        gain.gain.value = 0.04
        const dest = ac.createMediaStreamDestination()
        osc.connect(gain)
        gain.connect(dest)
        osc.start()
        demoRef.current = { ctx: ac, osc, gain }
        remote = dest.stream
      }
      if (!mountedRef.current) return
      remoteRef.current = remote
      if (viewerRef.current) viewerRef.current.srcObject = remote
      setViewPhase('viewing')
      if (!onViewStart) {
        pushAlert('info', 'DEMO MODE', 'No onViewStart hook — a local tone is playing so you can verify volume. Wire the hook to receive the host stream.', false)
      }
    } catch (e) {
      const c = classifyMediaError(e)
      setViewPhase('idle')
      pushAlert(c.kind, c.title, c.message, true, () => void beginViewing())
    }
  }, [viewPhase, onViewStart, teardownLocal, pushAlert])

  const setStreamRole = useCallback((next: StreamRole): void => {
    if (next === role) return
    stepRef.current++
    if (role === 'host') void stopBroadcast()
    else void stopViewing()
    teardownLocal()
    setRole(next)
    setPhase('idle')
    setViewPhase('idle')
    setElapsed(0)
    setMicOn(next === 'host')
    setSysOn(next === 'host')
    onRoleChange?.(next)
  }, [role, stopBroadcast, stopViewing, teardownLocal, onRoleChange])

  const toggleFs = useCallback(async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch {
      pushAlert('system', 'FULLSCREEN BLOCKED', 'The browser refused the fullscreen request — it must originate from a user click.', true)
    }
  }, [pushAlert])

  useEffect(() => {
    applyVolume(vol, muted)
  }, [vol, muted])

  useEffect(() => {
    if (role === 'host' && phase === 'live' && previewRef.current) {
      previewRef.current.srcObject = broadcastRef.current
    }
  }, [role, phase])

  useEffect(() => {
    if (role === 'viewer' && viewPhase === 'viewing' && viewerRef.current) {
      viewerRef.current.srcObject = remoteRef.current
    }
  }, [role, viewPhase])

  useEffect(() => {
    if (phase !== 'live') return
    let raf = 0
    const vals = [0, 0, 0, 0, 0]
    const tick = (): void => {
      const mx = mixerRef.current
      const m = mx?.meter
      if (m) {
        const data = new Uint8Array(m.frequencyBinCount)
        m.getByteFrequencyData(data)
        const bands = 5
        const step = Math.floor(data.length / bands)
        for (let b = 0; b < bands; b++) {
          let peak = 0
          for (let i = b * step; i < (b + 1) * step && i < data.length; i++) peak = Math.max(peak, data[i]!)
          const target = peak / 255
          vals[b] = Math.max(vals[b] * 0.7, target * 1.1)
        }
        if (mountedRef.current) setBars([...vals])
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  useEffect(() => {
    if (phase !== 'live') return
    setElapsed(0)
  }, [phase])

  const live = phase === 'live'
  const viewing = viewPhase === 'viewing'
  const sourceChips = [
    { on: micOn, label: 'MIC', ar: 'ميكروفون', icon: micOn ? P.mic : P.micOff, action: () => void toggleMic() },
    { on: sysOn, label: 'SYSTEM', ar: 'صوت النظام', icon: P.screen, action: () => void toggleSys() },
    { on: live, label: 'SCREEN', ar: 'الشاشة', icon: P.screen, action: undefined },
  ]

  return (
    <div className="flex min-h-screen w-full flex-col bg-noir font-sans text-white">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-white/10 bg-white/[0.03] px-5 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <BrandMark />
          <span className="font-mono text-[13px] uppercase tracking-[0.28em] text-white/90">{brand}</span>
        </div>

        <div className="mx-auto flex flex-col items-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/70">{sessionTitle}</span>
          <span className="font-mono text-[9px] tracking-[0.14em] text-white/30">{fmt(elapsed)}</span>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 backdrop-blur-xl sm:flex">
            <Icon d={P.user} size={13} className="text-indigo-300" />
            <span className="font-mono text-[10px] tracking-[0.1em] text-white/60">{audience} VIEWERS</span>
          </div>

          <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 backdrop-blur-xl">
            {(['host', 'viewer'] as const).map((r) => {
              const active = role === r
              return (
                <button key={r} onClick={() => setStreamRole(r)}
                  className={`rounded-full px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-all ${
                    active ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30' : 'text-white/40 hover:text-white/80'
                  }`}>
                  {r === 'host' ? 'التالي' : 'مباشر'}{' '}{r === 'host' ? 'HOST' : 'VIEWER'}
                </button>
              )
            })}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 sm:p-6">
        <div ref={stageRef}
          className={`relative overflow-hidden rounded-2xl border border-white/10 bg-noir-deep ${isFs ? 'h-full w-full rounded-none' : 'aspect-video'}`}>
          {role === 'host' ? (
            <>
              {live && broadcastRef.current && (
                <video ref={previewRef} autoPlay playsInline muted
                  className="absolute inset-0 h-full w-full object-contain" />
              )}
              {(!live || !broadcastRef.current) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(ellipse_at_center,rgba(129,140,248,0.08),transparent_65%)]">
                  <BrandMark size={48} />
                  <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/35">Broadcast stage is dark</p>
                  <p dir="rtl" className="text-[12px] text-white/25">الشاشة تظهر هنا عند بدء نقل الصورة والصوت</p>
                </div>
              )}

              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {live && (
                    <span className="flex items-center gap-2 rounded-full border border-neon/30 bg-noir/70 px-3 py-1.5 backdrop-blur-xl">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-neon shadow-[0_0_10px_2px_rgba(46,242,171,0.55)]" />
                      <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-neon">LIVE · {fmt(elapsed)}</span>
                    </span>
                  )}
                  {sourceChips.map(c => (
                    <button key={c.label} onClick={c.action} disabled={!c.action} title={c.ar}
                      className={`pointer-events-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[9px] tracking-[0.14em] transition-all ${
                        c.on ? 'border-neon/40 bg-neon/10 text-neon' : 'border-white/15 bg-white/5 text-white/35'
                      }`}>
                      <Icon d={c.icon} size={11} />
                      {c.label}
                    </button>
                  ))}
                </div>

                <button onClick={() => void toggleFs()} disabled={!live && !viewing}
                  title="زر توسيع شاشة المضيف"
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-white/15 bg-noir/70 px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] text-white/70 backdrop-blur-xl transition-all hover:border-white/40 hover:text-white disabled:opacity-40">
                  <Icon d={isFs ? P.compress : P.expand} size={13} />
                  {isFs ? 'EXIT' : 'EXPAND'}
                </button>
              </div>
            </>
          ) : (
            <>
              {viewing && remoteRef.current && (
                <video ref={viewerRef} autoPlay playsInline
                  className="absolute inset-0 h-full w-full object-contain" />
              )}
              {!viewing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[radial-gradient(ellipse_at_center,rgba(129,140,248,0.08),transparent_65%)]">
                  <BrandMark size={44} />
                  <button onClick={() => void beginViewing()}
                    disabled={viewPhase === 'connecting'}
                    className="flex items-center gap-2.5 rounded-xl bg-indigo-500 px-8 py-3.5 font-mono text-[12px] uppercase tracking-[0.18em] text-white shadow-xl shadow-indigo-500/30 transition-all hover:bg-indigo-400 disabled:opacity-60">
                    <Icon d={P.eye} size={15} />
                    {viewPhase === 'connecting' ? 'CONNECTING…' : 'عرض البث · VIEW STREAM'}
                  </button>
                  <p dir="rtl" className="max-w-xs text-center text-[11px] leading-relaxed text-white/35">
                    وضع المشاهدة يوقف الميكروفون والكاميرا محلياً فوراً — لمنع أصداء وحلقات التغذية الراجعة بين أجهزة الغرفة
                  </p>
                </div>
              )}
              {viewing && (
                <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
                  <span className="flex items-center gap-2 rounded-full border border-neon/30 bg-noir/70 px-3 py-1.5 backdrop-blur-xl">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-neon shadow-[0_0_10px_2px_rgba(46,242,171,0.55)]" />
                    <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-neon">STREAMING · {fmt(elapsed)}</span>
                  </span>
                  <button onClick={() => void stopViewing()}
                    className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-noir/70 px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] text-rose-400 backdrop-blur-xl transition-all hover:bg-rose-500/15">
                    <Icon d={P.eyeOff} size={13} />
                    LEAVE STREAM
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-md sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Icon d={P.vol} size={14} className="text-indigo-300" />
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/70">Local audio manager</span>
              <span dir="rtl" className="hidden text-[10px] text-white/30 sm:inline">التحكم الكامل بالصوت</span>
            </div>
            {role === 'viewer' && viewing && (
              <span className="flex items-center gap-1.5 rounded-full border border-neon/30 bg-neon/10 px-2.5 py-1 font-mono text-[9px] tracking-[0.14em] text-neon">
                <Icon d={P.shield} size={11} />
                INPUT SUSPENDED
              </span>
            )}
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex flex-1 items-center gap-3">
              <button onClick={() => { setMuted(m => !m) }} title={muted ? 'Unmute' : 'Mute'}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-all ${
                  muted ? 'border-rose-500/40 bg-rose-500/15 text-rose-400' : 'border-white/15 bg-white/5 text-white/80 hover:border-white/35'
                }`}>
                <Icon d={muted ? P.volX : P.vol} size={16} />
              </button>
              <input
                type="range" min={0} max={100} value={vol}
                onChange={(e) => { setVol(Number(e.target.value)); if (muted) setMuted(false) }}
                disabled={muted}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-indigo-500 disabled:opacity-40"
                aria-label="Output volume"
              />
              <span className="w-10 text-right font-mono text-[11px] tabular-nums text-white/80">{muted ? 0 : vol}%</span>
            </div>

            <div className="flex items-center gap-2">
              {bars.map((b, i) => (
                <div key={i} className="h-8 w-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="w-full bg-indigo-400 transition-all duration-75" style={{ height: `${clamp(b, 0, 1) * 100}%` }} />
                </div>
              ))}
            </div>
          </div>

          {role === 'host' && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
              {sourceChips.slice(0, 2).map(c => (
                <button key={c.label} onClick={c.action} title={c.ar}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-[10px] tracking-[0.12em] transition-all ${
                    c.on ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200' : 'border-white/15 bg-white/5 text-white/35 hover:text-white/70'
                  }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${c.on ? 'bg-neon shadow-[0_0_8px_1px_rgba(46,242,171,0.6)]' : 'bg-white/25'}`} />
                  {c.icon === P.screen && <Icon d={P.screen} size={12} />}
                  <span dir="rtl">{c.ar}</span>
                  <span className="text-white/40">{c.on ? 'ON' : 'OFF'}</span>
                </button>
              ))}
              <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-white/25">
                System audio + presenter mic → single blended output track · master volume maps to the broadcast output
              </p>
            </div>
          )}
        </section>

        <div className="flex justify-center pb-4">
          {role === 'host' ? (
            <button onClick={() => (live ? void stopBroadcast() : void beginBroadcast())}
              disabled={busy || phase === 'starting'}
              className={`flex items-center gap-3 rounded-xl px-10 py-4 font-mono text-[12px] uppercase tracking-[0.18em] transition-all disabled:opacity-60 ${
                live
                  ? 'border border-rose-500/50 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                  : 'bg-indigo-500 text-white shadow-xl shadow-indigo-500/30 hover:bg-indigo-400'
              }`}>
              <Icon d={live ? P.stop : P.upload} size={15} />
              {live ? 'وقف البث · STOP' : phase === 'starting' ? 'جارٍ التجهيز…' : 'نقل الصوت والصورة · START'}
            </button>
          ) : (
            viewing ? (
              <button onClick={() => void stopViewing()}
                className="flex items-center gap-2.5 rounded-xl border border-rose-500/50 bg-rose-500/15 px-8 py-3.5 font-mono text-[12px] uppercase tracking-[0.18em] text-rose-300 transition-all hover:bg-rose-500/25">
                <Icon d={P.eyeOff} size={15} />
                إغلاق المشاهدة
              </button>
            ) : (
              <button onClick={() => void beginViewing()} disabled={viewPhase === 'connecting'}
                className="flex items-center gap-2.5 rounded-xl bg-indigo-500 px-8 py-3.5 font-mono text-[12px] uppercase tracking-[0.18em] text-white shadow-xl shadow-indigo-500/30 transition-all hover:bg-indigo-400 disabled:opacity-60">
                <Icon d={P.eye} size={15} />
                {viewPhase === 'connecting' ? 'CONNECTING…' : 'عرض البث · VIEW STREAM'}
              </button>
            )
          )}
        </div>
      </main>

      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[92vw] flex-col gap-2">
        {alerts.map(a => (
          <div key={a.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border p-3 shadow-2xl backdrop-blur-xl ${
              a.kind === 'info'
                ? 'border-indigo-500/40 bg-noir-raise/90'
                : a.kind === 'permission'
                  ? 'border-amber-400/50 bg-noir-raise/95'
                  : a.kind === 'device'
                    ? 'border-rose-500/50 bg-noir-raise/95'
                    : 'border-white/20 bg-noir-raise/95'
            }`}>
            <Icon d={P.alert} size={14} className={`mt-0.5 ${a.kind === 'info' ? 'text-indigo-300' : a.kind === 'device' ? 'text-rose-400' : 'text-amber-300'}`} />
            <div className="min-w-0 flex-1">
              <p className={`font-mono text-[10px] font-bold tracking-[0.14em] ${a.kind === 'info' ? 'text-indigo-200' : a.kind === 'device' ? 'text-rose-300' : 'text-amber-200'}`}>{a.title}</p>
              <p dir="rtl" className="mt-1 text-[11px] leading-relaxed text-white/65">{a.detail}</p>
              {a.retry && (
                <button onClick={a.retry}
                  className="mt-2 flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] text-white/85 transition-all hover:bg-white/20">
                  <Icon d={P.refresh} size={11} />
                  RETRY
                </button>
              )}
            </div>
            <button onClick={() => dropAlert(a.id)} className="text-white/30 transition-colors hover:text-white/80">
              <Icon d={'<line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>'} size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}