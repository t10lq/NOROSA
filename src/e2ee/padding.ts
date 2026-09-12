import { b64Decode, b64Encode, utf8ToBytes } from './encoding'

/**
 * Message padding (metadata protection).
 *
 * The blind relay can watch the *size* of every envelope. Deliberately
 * variable-length plaintexts would let it fingerprint the content class
 * (e.g. a URL, a short reply, a long paste). Padding every message to a
 * fixed bucket removes that signal entirely.
 *
 * Layout (inside the padded buffer):
 *   [ original bytes ][ padding bytes ][ payload_len (1 byte) ]
 *
 * The trailing byte records the real length so `unpad` can cut precisely.
 */

/** Padding buckets in bytes — messages are rounded UP to the nearest bucket. */
const BUCKET = 256

export function pad(text: string): string {
  const body = utf8ToBytes(text)
  const padLen = BUCKET - ((body.length + 1) % BUCKET)
  const padded = new Uint8Array(body.length + 1 + padLen)
  padded.set(body, 0)
  // Bandwidth-neutral noise: fill the middle with cryptographically random bytes
  // so two padded blobs of the same class carry no structural watermark. The
  // very last byte is reserved for the length so `unpad` can cut precisely.
  crypto.getRandomValues(padded.subarray(body.length, padded.length - 1))
  padded[padded.length - 1] = body.length
  return b64Encode(padded)
}

export function unpad(paddedB64: string): string {
  const padded = b64Decode(paddedB64)
  if (padded.length < 1) throw new Error('Corrupt padded payload: empty.')
  const len = padded[padded.length - 1]!
  if (len >= padded.length) throw new Error('Corrupt padded payload: bad length byte.')
  return bytesToUtf8(padded.subarray(0, len))
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Re-export for convenience at the call site. */
export const MAX_BUCKET = BUCKET