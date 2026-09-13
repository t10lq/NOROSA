import { useRef, useEffect } from 'react'
import type { SpeakerRouter } from '../../e2ee/speakerRouter'

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
    else router.detach(peer)
  }, [router, peer, sig, stream])
  useEffect(() => () => router.detach(peer), [router, peer])
  return (
    <video ref={ref} autoPlay playsInline
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
        background: '#0a0a0b',
      }} />
  )
}