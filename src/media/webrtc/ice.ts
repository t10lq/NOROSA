export function fallbackIceServers(): RTCIceServer[] {
  // STUN lets two browsers on the same LAN (mDNS-hidden hosts) still find each
  // other through server-reflexive candidates. A production TURN relay can be
  // supplied via configure(); without it, direct + STUN paths only.
  return [{ urls: ['stun:stun.l.google.com:19302'] }]
}

function b64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** coturn TURN creds (use-auth-secret REST scheme): username = expiry epoch,
 *  credential = base64url(HMAC-SHA1(secret, username)). Minted client-side at
 *  runtime from VITE_TURN_SECRET, so the TURN server can enforce short leases
 *  without any round trip to our backend. */
async function turnServers(): Promise<RTCIceServer[]> {
  const urlsRaw = import.meta.env.VITE_TURN_URLS as string | undefined
  const secret = import.meta.env.VITE_TURN_SECRET as string | undefined
  if (!urlsRaw || !secret) return []
  const urls = urlsRaw.split(',').map(s => s.trim()).filter(Boolean)
  if (urls.length === 0) return []
  const ttl = 30 * 60
  const username = String(Math.floor(Date.now() / 1000) + ttl)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username)))
  return [{ urls, username, credential: b64Url(mac) }]
}

/** Full ICE server list for a peer connection: our TURN relay (handles
 *  symmetric NAT / guest Wi-Fi, which pure STUN never does) plus a public
 *  STUN for the fast LAN/server-reflexive paths. Empty build-time TURN config
 *  keeps the old STUN-only behaviour. */
export async function defaultIceServers(): Promise<RTCIceServer[]> {
  return [...(await turnServers()), ...fallbackIceServers()]
}
