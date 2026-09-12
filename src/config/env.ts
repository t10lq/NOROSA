// Point the client at the relay with VITE_RELAY_URL (e.g. wss://relay.example.com)
// — falls back to the local dev relay. Must be a WebSocket URL.
export const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? 'ws://127.0.0.1:8081'