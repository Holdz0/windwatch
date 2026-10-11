export const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL ||
  (import.meta.env.DEV ? 'http://localhost:5000' : window.location.origin)).replace(/\/$/, '');

export function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const urls = (import.meta.env.VITE_TURN_URL as string | undefined)?.split(',').map(url => url.trim()).filter(Boolean);
  if (urls?.length) servers.push({ urls,
    username: import.meta.env.VITE_TURN_USERNAME,
    credential: import.meta.env.VITE_TURN_CREDENTIAL });
  else servers.push({
    // Preserve the fallback relay used by the previous PeerJS configuration.
    // A dedicated TURN service is preferable for predictable availability.
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs', credential: 'peerjsp'
  });
  return servers;
}
