import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useE2e } from './E2eContext'
import { MediaCallClient, defaultIceServers, probeEncodedStreamsCaps, type EncodedCapsProbe, type MediaCallEvents } from '../e2ee/webrtc'

/**
 * Media-plane bridge.
 *
 * Owns exactly ONE MediaCallClient per E2eEncryptionService lifetime and
 * exposes just enough surface for the room UI: mute/video toggles (real
 * replaceTrack calls — the connection never drops), the remote stream per
 * peer for rendering, and the shared local camera preview track.
 *
 * Permission handling: a denied microphone never kills the call (the audio
 * m-line is negotiated with a null track; granting later injects it via
 * replaceTrack). Blocked grants are surfaced as micBlocked / camBlocked so
 * the room can show clear hints instead of a silent failure.
 *
 * When the browser lacks RTCRtpScriptTransform the provider stays live but
 * supported=false; the room then renders without media rather than crashing.
 */

export interface CallContextValue {
  /** null until the crypto engine is ready (or when unsupported). */
  media: MediaCallClient | null
  supported: boolean
  /** Human reason from the deep capability probe when unsupported. */
  supportReason: string | null
  /** Remote mix per peer alias — a fresh Map instance on every change. */
  remoteStreams: ReadonlyMap<string, MediaStream>
  /** Per-peer mic muted state, driven by explicit mute signaling. */
  peerMics: ReadonlyMap<string, boolean>
  /** Peers whose inbound frames are actively failing decryption (black video). */
  decryptDrops: ReadonlyMap<string, boolean>
  micOn: boolean
  camOn: boolean
  /** A capture request is in flight (permission prompt open). */
  camPending: boolean
  micPending: boolean
  /** Shared local camera track (null until video is enabled). */
  localCamera: MediaStreamTrack | null
  /** True when the browser refused the microphone/camera, until granted. */
  micBlocked: boolean
  camBlocked: boolean
  /** Browser-provided reason for the refusal (NotAllowedError etc.). */
  micError: string | null
  camError: string | null
  peerStates: ReadonlyMap<string, RTCPeerConnectionState>
  toggleMic: () => void
  toggleCam: () => void
  setMicOn: (on: boolean) => void
  setCamOn: (on: boolean, deviceId?: string) => void
  reconfigureDevices: (micId: string | null, camId: string | null) => void
}

const CallContext = createContext<CallContextValue | null>(null)

export function CallProvider({ children }: { children: ReactNode }) {
  const { service, isReady } = useE2e()
  const [media, setMedia] = useState<MediaCallClient | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<ReadonlyMap<string, MediaStream>>(new Map())
  const [peerMics, setPeerMics] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [decryptDrops, setDecryptDrops] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [peerStates, setPeerStates] = useState<ReadonlyMap<string, RTCPeerConnectionState>>(new Map())
  const [micOn, setMicOnState] = useState(true)
  const [camOn, setCamOnState] = useState(false)
  const [localCamera, setLocalCamera] = useState<MediaStreamTrack | null>(null)
  const [micBlocked, setMicBlocked] = useState(false)
  const [camBlocked, setCamBlocked] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [camPending, setCamPending] = useState(false)
  const [micPending, setMicPending] = useState(false)
  const [supportProbe, setSupportProbe] = useState<EncodedCapsProbe | null>(null)

  const mediaRef = useRef<MediaCallClient | null>(null)
  const micOnRef = useRef(micOn)
  const camOnRef = useRef(camOn)
  micOnRef.current = micOn
  camOnRef.current = camOn

  useEffect(() => {
    if (!service || !isReady) return

    // Deep capability probe — some embedded webviews expose the ctor but the
    // constructed transform has no readable/writable (stubbed pipeline), so
    // E2EE media can never attach there. Log the truth instead of guessing.
    const probe = probeEncodedStreamsCaps()
    console.log('[media] capability probe →', JSON.stringify(probe))
    setSupportProbe(probe)

    const events: MediaCallEvents = {
      onStream: (peer, stream) => {
        setRemoteStreams(prev => {
          const next = new Map(prev)
          next.set(peer, stream)
          return next
        })
        // A fresh stream may be a re-negotiation with salvaged crypto.
        setDecryptDrops(prev => {
          if (!prev.has(peer)) return prev
          const next = new Map(prev)
          next.delete(peer)
          return next
        })
      },
      onPeerState: (peer, state) => {
        setPeerStates(prev => new Map(prev).set(peer, state))
      },
      onFrameDrop: (peer) => {
        setDecryptDrops(prev => new Map(prev).set(peer, true))
      },
      onPeerMic: (peer, muted) => {
        setPeerMics(prev => new Map(prev).set(peer, muted))
      },
      onMicError: (message) => {
        setMicBlocked(true)
        setMicError(message ?? 'Permission denied')
        setMicPending(false)
        // We have no mic to send with — reflect the truth in the badge.
        setMicOnState(false)
        micOnRef.current = false
      },
      onCamError: (message) => {
        setCamBlocked(true)
        setCamError(message ?? 'Permission denied')
      },
    }

    let client: MediaCallClient | null = null
    let cancelled = false
    void (async () => {
      // TURN creds are minted at runtime (static-auth-secret REST scheme) — a
      // short await that resolves instantly when no TURN is configured.
      const ice = await defaultIceServers()
      if (cancelled) return
      client = new MediaCallClient(service, events, ice)
      mediaRef.current = client
      setMedia(client)
      void client.start()
    })()

    return () => {
      cancelled = true
      mediaRef.current = null
      client?.dispose()
      setMedia(null)
      setRemoteStreams(new Map())
      setPeerMics(new Map())
      setPeerStates(new Map())
    }
  }, [service, isReady])

  const setMicOn = useCallback((on: boolean) => {
    const prev = micOnRef.current
    if (on) setMicPending(true)
    setMicOnState(on)
    const c = mediaRef.current
    if (!c) {
      setMicPending(false)
      if (on) setMicBlocked(true)
      return
    }
    void (async () => {
      try {
        await c.setMicOn(on)
        setMicBlocked(false)
        setMicError(null)
      } catch {
        setMicOnState(prev)
        micOnRef.current = prev
        setMicBlocked(true)
      } finally {
        setMicPending(false)
      }
    })()
  }, [])

  const toggleMic = useCallback(() => setMicOn(!micOnRef.current), [setMicOn])

  const setCamOn = useCallback((on: boolean, deviceId?: string) => {
    const prev = camOnRef.current
    if (on) setCamPending(true)
    setCamOnState(on)
    if (on) setLocalCamera(null)
    const c = mediaRef.current
    if (!c) {
      setCamPending(false)
      if (on) setCamBlocked(true)
      return
    }
    void (async () => {
      try {
        await c.setVideoEnabled(on, deviceId)
        setLocalCamera(c.localCameraTrack())
        setCamBlocked(false)
        setCamError(null)
      } catch {
        setCamOnState(prev)
        camOnRef.current = prev
        setLocalCamera(null)
        setCamBlocked(true)
      } finally {
        setCamPending(false)
      }
    })()
  }, [])

  const toggleCam = useCallback(() => setCamOn(!camOnRef.current), [setCamOn])

  const reconfigureDevices = useCallback((micId: string | null, camId: string | null) => {
    void (async () => {
      const c = mediaRef.current
      if (!c) return
      if (micOnRef.current) {
        try {
          await c.setMicOn(true, micId ?? 'default')
          setMicBlocked(false)
          setMicError(null)
        } catch {
          setMicBlocked(true)
        }
      }
      if (camOnRef.current) {
        try {
          await c.setVideoEnabled(true, camId ?? 'default')
          setLocalCamera(c.localCameraTrack())
          setCamBlocked(false)
          setCamError(null)
        } catch {
          setCamBlocked(true)
        }
      }
    })()
  }, [])

  const value = useMemo<CallContextValue>(
    () => ({
      media,
      supported: supportProbe?.supported ?? false,
      supportReason: supportProbe?.reason ?? null,
      remoteStreams,
      peerMics,
      decryptDrops,
      peerStates,
      micOn,
      camOn,
      camPending,
      micPending,
      localCamera,
      micBlocked,
      camBlocked,
      micError,
      camError,
      toggleMic,
      toggleCam,
      setMicOn,
      setCamOn,
      reconfigureDevices,
    }),
    [media, remoteStreams, peerMics, decryptDrops, peerStates, micOn, camOn, camPending, micPending, localCamera, micBlocked, camBlocked, micError, camError, toggleMic, toggleCam, setMicOn, setCamOn, reconfigureDevices],
  )

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>
}

export function useCalls(): CallContextValue {
  const ctx = useContext(CallContext)
  if (!ctx) throw new Error('useCalls must be used within <CallProvider>.')
  return ctx
}