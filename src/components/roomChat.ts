/**
 * Tiny module-level chat store shared by the always-on RoomReceiver (which
 * decrypts + bootstraps even while the panel is hidden) and the visible
 * RoomComponent panel. Subscribers re-render on any change.
 */

import type { DecryptedMessage, SafetyStatus } from '../e2ee/E2eEncryptionService'

export interface ChatMessage {
  id: string
  alias: string
  text: string
  ts: number
}

type Listener = () => void

let messages: ChatMessage[] = []
let groupId: string | null = null
let peers: string[] = []
/** Safety fingerprints, bound to the peer alias they belong to. */
let safetyByPeer: Record<string, SafetyStatus> = {}
let peerNote: string | null = null
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l()
}

export function resetRoomChat() {
  messages = []
  groupId = null
  peers = []
  safetyByPeer = {}
  peerNote = null
  emit()
}

export function pushChatMessage(m: DecryptedMessage) {
  messages = [...messages, { id: crypto.randomUUID(), alias: m.from, text: m.text, ts: Date.now() }]
  emit()
}

export function pushLocalMessage(alias: string, text: string) {
  messages = [...messages, { id: crypto.randomUUID(), alias, text, ts: Date.now() }]
  emit()
}

export function getChatMessages(): ChatMessage[] {
  return messages
}

export function setChatGroup(group: string | null) {
  groupId = group
  emit()
}

export function getChatGroup(): string | null {
  return groupId
}

export function setChatPeers(p: string[]) {
  peers = p
  emit()
}

export function getChatPeers(): string[] {
  return peers
}

export function setChatSafety(peer: string, status: SafetyStatus) {
  safetyByPeer = { ...safetyByPeer, [peer]: status }
  emit()
}

export function getChatSafety(peer: string): SafetyStatus | undefined {
  return safetyByPeer[peer]
}

export function getChatSafetyMap(): Record<string, SafetyStatus> {
  return safetyByPeer
}

export function setChatNote(n: string | null) {
  peerNote = n
  emit()
}

export function getChatNote(): string | null {
  return peerNote
}

export function subscribeRoomChat(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}