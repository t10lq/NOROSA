/**
 * Safety number — a short, deterministic, user-comparable fingerprint of a
 * private conversation pairing.
 *
 * Both parties feed the SAME two identity keys (sorted, so the order is
 * symmetric) into SHA-256. The digest is folded into six 5-digit groups that
 * match on both screens if (and only if) both hold the other party's genuine
 * public identity. Bob reads "04392 81765 …" in his chat, ends you confirm the
 * same grouping out-of-band — and a whole-class of man-in-the-middle attacks
 * (a swapped bundle at the very first hello) becomes visible instantly,
 * because no attacker can forge a SHA-256 digest over identities they do not
 * control.
 */

import { utf8ToBytes } from './encoding'

export async function safetyNumber(identityA: string, identityB: string): Promise<string> {
  const [first, second] = identityA < identityB ? [identityA, identityB] : [identityB, identityA]
  const digest = await crypto.subtle.digest('SHA-256', utf8ToBytes(first + second))
  const bytes = new Uint8Array(digest)
  const groups: string[] = []
  for (let i = 0; i < 6; i++) {
    let v = 0
    for (let j = 0; j < 4; j++) v = (v * 256 + (bytes[i * 4 + j] ?? 0)) % 100_000
    groups.push(String(v).padStart(5, '0'))
  }
  return groups.join(' ')
}