/** Small binary helpers used everywhere in the crypto pipeline. */

export function b64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

export function b64Decode(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

export function utf8ToBytes(str: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(str)
}

export function bytesToBase64(bytes: Uint8Array): string {
  return b64Encode(bytes)
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return b64Decode(b64)
}

/**
 * Chunked export for worker scopes where a single huge btoa() call can blow
 * the call stack on large video key-frames (64KB+ buffers).
 */
export function bytesToBase64Chunked(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}

export function base64ToBytesChunked(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

/** Uint8Array → ArrayBuffer for frame payloads that must be transferred. */
export function bytesToBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}