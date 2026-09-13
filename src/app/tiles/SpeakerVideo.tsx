import { useRef, useEffect } from 'react'
import type { SpeakerRouter } from '../../media/speakerRouter'

// Remote video routed through the SpeakerRouter — re-uses the raw stream but
// lets the router decide between the WebAudio speakerphone path and the native
// element (earpiece) path, and explicitly starts playback.
export function SpeakerVideo({ router, peer, stream }: { router: SpeakerRouter; peer: string; stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const sig = stream ? `${stream.getAudioTracks().length}/${stream.getVideoTracks().length}` : 'none'
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (stream) router.attach(peer, el, stream)
    else {
      router.detach(peer)
      el.srcObject = null
    }
  }, [router, peer, sig, stream])
  // A remote camera going off mid-call freezes the element on its last frame.
  // Receiver tracks fire 'mute' when the sender stops sending — drop the old
  // picture; the next 'unmute' re-attaches through the router.
  useEffect(() => {
    const el = ref.current
    if (!el || !stream) return
    const v = [...stream.getVideoTracks()].filter(t => t.readyState === 'live').pop() ?? null
    if (!v) return
    const onMute = () => { if (ref.current) ref.current.srcObject = null }
    const onUnmute = () => { if (ref.current) router.attach(peer, ref.current as HTMLVideoElement, stream) }
    v.addEventListener('mute', onMute)
    v.addEventListener('unmute', onUnmute)
    return () => {
      v.removeEventListener('mute', onMute)
      v.removeEventListener('unmute', onUnmute)
    }
  }, [router, peer, sig, stream])
  useEffect(() => () => {
    router.detach(peer)
    if (ref.current) ref.current.srcObject = null
  }, [router, peer])
  return (
    <video ref={ref} autoPlay playsInline
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
        background: '#0a0a0b',
      }} />
  )
}