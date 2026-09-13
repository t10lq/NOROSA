/**
 * Zero-knowledge room codes.
 *
 *   • 9 bytes from `crypto.getRandomValues`  →  18 hex chars  →  human
 *     groups `A67-DE3-A67-F2B-9B3-2B1` (72 bits of real entropy).
 *   • The wire and the server only ever see the SHA-256 of the canonical
 *     form. A 256-bit digest over a 72-bit secret cannot be reversed, and
 *     it cannot be brute-forced against the relay either: every wrong guess
 *     must round-trip to the server, which rate-limits joins (see the relay).
 *
 * Consequently neither the server, an operator with the SQLite file, nor
 * anyone who drains the database can learn — or guess — the room code.
 * The relay holds a hash it can compare, never a secret it can disclose.
 */

import { utf8ToBytes } from '../crypto/encoding'

const CODE_BYTES = 9
const CODE_HEX_LEN = CODE_BYTES * 2

/**
 * Mint a fresh, readable room code from a CSPRNG. Groups of three hex digits.
 * Example: `A67-DE3-A67-F2B-9B3-2B1`.
 */
export function generateRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES))
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  return formatRoomCode(hex)
}

/**
 * Canonicalize whatever the user typed: strip everything that is not a hex
 * digit, then uppercase. `a67-de3-a67-f2b-9b3-2b1`, `a67de3a67f2b9b32b1` and
 * `A67-DE3-…` all collapse to the same 18-char key. This canonical string —
 * not the formatted one — is hashed, so every client agrees byte-for-byte.
 */
export function normalizeRoomCode(input: string): string {
  return input.trim().replace(/[^0-9a-f]/gi, '').toUpperCase()
}

/** `A67DE3A67F2B9B32B1` → `A67-DE3-A67-F2B-9B3-2B1`. */
export function formatRoomCode(canonical: string): string {
  const hex = normalizeRoomCode(canonical)
  return (hex.match(/.{3}/g) ?? []).join('-')
}

export function isValidCode(canonical: string): boolean {
  return canonical.length === CODE_HEX_LEN && /^[0-9A-F]+$/.test(canonical)
}

/**
 * SHA-256 of the canonical code. This — and only this — is what leaves the
 * browser. Deterministic on both ends, emitted as 64 lowercase hex chars.
 */
export async function hashRoomCode(code: string): Promise<string> {
  const canonical = normalizeRoomCode(code)
  const digest = await crypto.subtle.digest('SHA-256', utf8ToBytes(canonical))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}