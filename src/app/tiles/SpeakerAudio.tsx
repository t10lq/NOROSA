import { useRef, useEffect } from 'react'
import type { SpeakerRouter } from '../../media/speakerRouter'

// Remote AUDIO-ONLY tile routed through the SpeakerRouter. An audio-only
// remote mix has no video element to ride on (the old tiles only mounted a
// <video> when a video track existed), so this <audio> twin carries the
// speakerphone / setSinkId / play() responsibilities of SpeakerVideo for the
// no-camera case. Invisible — the tile still shows the participant nameplate.
export function SpeakerAudio({ router, peer, stream }: { router: SpeakerRouter; peer: string; stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const sig = stream ? `a${stream.getAudioTracks().length}` : 'none'
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (stream) {
      router.attach(peer, el, stream)
    } else {
      router.detach(peer)
      el.srcObject = null
    }
    return () => {
      router.detach(peer)
      el.pause()
      el.srcObject = null
    }
  }, [router, peer, sig, stream])
  return <audio ref={ref} autoPlay playsInline style={{ display: 'none' }} />
}