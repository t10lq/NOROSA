/**
 * NOROSA E2EE — Wire-level envelope types (client-side mirror).
 *
 * Every payload that crosses the WebSocket link to the blind relay is
 * treated as an opaque string.  The relay never parses message bodies.
 * These types define the *control plane* (key registration, routing)
 * only; the *data plane* (actual ciphertext) is a free-form string.
 */

/** Public key bundle uploaded per member for X3DH bootstrap. */
export interface PublicKeyBundle {
  identityKey: string
  ed25519: string
  signedPrekey: string
  signedPrekeySig: string
}

/** A one-time pre-key that can only ever be consumed once. */
export interface OneTimePrekey {
  keyId: string
  key: string
}

/** Result of a keys.get response, keyed by peer alias. */
export interface PeerKeyBundle {
  keys: PublicKeyBundle
  oneTimeKey?: OneTimePrekey
}

/** Messages exchanged with the blind relay. */
export interface WireHello     { t: 'hello';     roomCode: string; create: boolean }
export interface WireUpload    { t: 'keys.upload'; roomCode: string; keys: PublicKeyBundle; oneTimeKeys: OneTimePrekey[] }
export interface WireGetKeys   { t: 'keys.get';    roomCode: string; txn: string }
export interface WireKeysResult{ t: 'keys.result'; txn: string; users: Record<string, PeerKeyBundle> }
/** A single opaque ciphertext blob targeting everyone ('*') or one peer. */
export interface WireMsg       { t: 'msg'; roomCode: string; to: string; id: string; payload: string }
/** Media-plane signaling (SDP offer/answer, ICE trickle) — routed verbatim,
 *  never parsed. The payload is already double-ratchet ciphertext. */
export interface WireCall      { t: 'call'; roomCode: string; to: string; id: string; payload: string }
export interface WireDeliveredCall { t: 'call'; from: string; id: string; payload: string }
export interface WireAck       { t: 'ack'; id?: string; alias?: string }
export interface WireError     { t: 'error'; code: string; message: string }
export interface WireMailbox   { t: 'mailbox'; messages: WireDelivered[] }
export interface WireDelivered { t: 'msg'; from: string; id: string; payload: string }
export interface WirePresence { t: 'presence'; alias: string; online: boolean }
export interface WireDestroy   { t: 'room.destroy'; roomCode: string }

export type WireIn  = WireAck | WireKeysResult | WireDelivered | WireDeliveredCall | WireMailbox | WirePresence | WireError
export type WireOut = WireHello | WireUpload | WireGetKeys | WireMsg | WireCall | WireDestroy
