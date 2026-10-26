export function b64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz'; // no 0/1/l/o confusion

export function randomId(len = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return s;
}

// 20 chars * 5 bits = 100 bits of entropy; grouped for readability.
export function newRoomCode() {
  return randomId(20).match(/.{5}/g).join('-');
}

export async function compress(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return b64u(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function decompress(code) {
  const stream = new Blob([unb64u(code)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

export function fmtDuration(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// Short authentication string from both DTLS fingerprints. If both people
// see the same code, nobody is sitting in the middle of the call.
export async function securityCode(fpA, fpB) {
  const data = new TextEncoder().encode([fpA, fpB].sort().join('|'));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const s = String(n % 100000000).padStart(8, '0');
  return s.slice(0, 4) + ' ' + s.slice(4);
}

export function fingerprintOf(sdp) {
  const m = /a=fingerprint:(\S+ \S+)/.exec(sdp || '');
  return m ? m[1] : '';
}
