import { useEffect, useRef } from 'react'
import { useE2e } from '../../../context/E2eContext'
import {
  getChatGroup,
  getChatSafety,
  pushChatMessage,
  resetRoomChat,
  setChatGroup,
  setChatNote,
  setChatPeers,
  setChatSafety,
} from '../../../store/roomChat'

/**
 * Runs the room crypto pipeline for as long as the room view is open —
 * whether or not the chat panel itself is visible.
 *
 * If the chat panel owned this lifecycle (as it used to), messages sent while
 * the panel was closed were dropped: nobody had ever booted the group session
 * or shared keys, so the inbound ciphertext had nothing to decrypt into. This
 * receiver keeps the protocol alive from the moment the user enters the room;
 * messages queued up get pushed into the shared store and appear the moment
 * the chat is opened. It also polls presence so the video grid always shows
 * exactly who is really in the room. Renders nothing.
 */
export function RoomReceiver() {
  const { service, isReady } = useE2e()
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!service || !isReady) return
    let cancelled = false
    resetRoomChat()

    const unsubscribe = service.onMessage(m => {
      if (!cancelled) pushChatMessage(m)
    })

    const adoptPeer = async (peer: string) => {
      if (cancelled) return
      const fresh = await service.listPeers()
      if (!cancelled) setChatPeers(mergeWithOnline(fresh))
      try {
        setChatSafety(peer, await service.safetyStatusFor(peer))
      } catch { /* keys not uploaded yet */ }
    }

    // The grid must show EVERYONE present: keyed peers PLUS peers confirmed
    // online via presence (a peer who shares our device identity is filtered
    // out of listPeers and would otherwise vanish from every screen).
    const mergeWithOnline = (list: string[]) => {
      const self = service.selfAlias
      return [...new Set([...list, ...service.listOnlinePeers()].filter(a => a !== self))]
    }

    // A peer just appeared (hello) or disappeared (socket close). React
    // instantly — no waiting for the next presence poll — and make sure the
    // newcomer can decrypt our group messages as soon as they arrive.
    service.onPresence((peer, online) => {
      if (cancelled) return
      if (!online) {
        void (async () => {
          try {
            if (cancelled) return
            const fresh = await service.listPeers()
            if (!cancelled) setChatPeers(mergeWithOnline(fresh))
          } catch { /* transient */ }
        })()
        return
      }
      void (async () => {
        // The newcomer is in the room the instant their hello lands — but
        // their key bundle (and thus their grid tile) may still be uploading
        // for a second or two. Be patient so the tile appears without a
        // reload instead of giving up on the first miss.
        for (let attempt = 0; attempt < 12 && !cancelled; attempt++) {
          try {
            await service.initiateSession(peer)
            if (cancelled) return
            const gid = getChatGroup()
            if (gid) await service.shareGroupSessionKey(gid, peer)
            if (cancelled) return
            await adoptPeer(peer)
            return
          } catch {
            if (cancelled) return
            await new Promise(r => setTimeout(r, 700))
          }
        }
      })()
    })

    const boot = async () => {
      try {
        const gid = await service.createGroupSession()
        if (cancelled) return
        await service.joinGroup(gid)
        setChatGroup(gid)

        // Peers may join late — poll the blind relay a little while.
        for (let attempt = 0; attempt < 12 && !cancelled; attempt++) {
          const others = await service.listPeers()
          if (cancelled) return
          setChatPeers(mergeWithOnline(others))
          for (const p of others) {
            try {
              await service.initiateSession(p)
            } catch {
              /* peer still provisioning keys — retried next round */
            }
          }
          // Safety fingerprint for EVERY peer present, not just the first.
          for (const p of others) {
            try {
              await adoptPeer(p)
            } catch { /* identity not up yet */ }
          }
          if (others.length > 0) break
          await new Promise(r => setTimeout(r, 1200 + attempt * 400))
        }
        if (cancelled) return

        // Share the Megolm key to each peer over their private ratchet.
        const others = await service.listPeers()
        setChatPeers(mergeWithOnline(others))
        if (others.length > 0) {
          for (const p of others) {
            try {
              await service.shareGroupSessionKey(gid, p)
            } catch {
              /* skip — the peer will refresh on the next message */
            }
          }
          setChatNote(null)
        } else {
          setChatNote('Waiting for a peer to join this room…')
        }

        // Keep the presence grid live: whenever someone joins or leaves the
        // room, listPeers reflects it. Poll quietly so the UI never disagrees
        // with who is actually here. The tick also self-heals "FINGERPRINTING…":
        // a peer whose key bundle was still uploading on their first sighting
        // (a normal few-hundred-ms race) is retried every tick until the
        // fingerprint commits — instead of hanging forever.
        tickRef.current = setInterval(async () => {
          if (cancelled) return
          try {
            const fresh = await service.listPeers()
            if (!cancelled) setChatPeers(mergeWithOnline(fresh))
            for (const p of fresh) {
              if (cancelled) return
              if (getChatSafety(p)) continue
              try {
                await adoptPeer(p)
              } catch { /* still provisioning — retried next tick */ }
            }
          } catch {
            /* relay hiccup — retried next tick */
          }
        }, 3000)
      } catch (err) {
        if (!cancelled) setChatNote(err instanceof Error ? err.message : 'Failed to boot room protocol.')
      }
    }

    void boot()
    return () => {
      cancelled = true
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      unsubscribe()
    }
  }, [service, isReady])

  return null
}