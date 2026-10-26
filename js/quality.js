// Opus quality presets, ordered from cheapest to best.
// kbps = audio payload bitrate. ptime = packet length in ms: longer packets
// mean fewer packet headers, which matters a lot on slow links (at 20 ms the
// IP/UDP/RTP headers alone cost ~16 kbps; at 60 ms only ~5 kbps).
export const PRESETS = [
  { id: 'ultra',    name: 'Ultra low', hint: '2G / very slow',   kbps: 8,  rate: 8000,  ptime: 60, dtx: 1, fec: 1 },
  { id: 'saver',    name: 'Data saver', hint: '3G / weak signal', kbps: 14, rate: 16000, ptime: 40, dtx: 1, fec: 1 },
  { id: 'balanced', name: 'Balanced',  hint: 'Most connections', kbps: 24, rate: 24000, ptime: 20, dtx: 1, fec: 1 },
  { id: 'hd',       name: 'HD voice',  hint: 'Wi-Fi / 4G',       kbps: 40, rate: 48000, ptime: 20, dtx: 1, fec: 1 },
  { id: 'studio',   name: 'Studio',    hint: 'Fast & stable',    kbps: 96, rate: 48000, ptime: 20, dtx: 0, fec: 1 },
];

export const AUTO = 'auto';

export function levelOf(id) {
  const i = PRESETS.findIndex((p) => p.id === id);
  return i < 0 ? 3 : i;
}

// Rough total bandwidth per direction including packet overhead (~ 60 bytes
// IPv4+UDP+RTP+SRTP per packet), used for the "≈ MB per hour" hint.
export function estimateKbps(p) {
  return p.kbps + (1000 / p.ptime) * 60 * 8 / 1000;
}

export function mbPerHour(p) {
  // both directions, assume ~60% talk time thanks to DTX
  const talk = p.dtx ? 0.6 : 1;
  return Math.round(estimateKbps(p) * 2 * talk * 3600 / 8 / 1024);
}

// Initial guess for Auto mode from the Network Information API (Chromium only).
export function initialAutoLevel() {
  const c = navigator.connection;
  if (!c) return 3;
  if (c.saveData) return 1;
  if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return 0;
  if (c.effectiveType === '3g') return 1;
  if (typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 0.4) return 1;
  return 3;
}

// Rewrite the Opus fmtp line of an SDP. In SDP these parameters describe what
// the author wants to RECEIVE, so the remote encoder follows them.
export function mungeSdp(sdp, p) {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  const params = {
    minptime: 10,
    useinbandfec: p.fec,
    usedtx: p.dtx,
    stereo: 0,
    'sprop-stereo': 0,
    maxaveragebitrate: p.kbps * 1000,
    maxplaybackrate: p.rate,
    'sprop-maxcapturerate': p.rate,
    cbr: 0,
  };
  const line = `a=fmtp:${pt} ` + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(';');
  const fmtpRe = new RegExp(`a=fmtp:${pt} [^\\r\\n]*`);
  sdp = fmtpRe.test(sdp) ? sdp.replace(fmtpRe, line) : sdp.replace(m[0], `${m[0]}\r\n${line}`);
  // ptime is per media section; keep exactly one for the audio section.
  sdp = sdp.replace(/a=(max)?ptime:\d+\r\n/g, '');
  sdp = sdp.replace(/(m=audio[^\r\n]*\r\n)/, `$1a=ptime:${p.ptime}\r\na=maxptime:${Math.max(60, p.ptime)}\r\n`);
  return sdp;
}

// Put Opus first so it is always picked (it is in every browser anyway).
export function preferOpus(transceiver) {
  if (!transceiver.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
  const caps = RTCRtpReceiver.getCapabilities('audio');
  if (!caps) return;
  const opus = caps.codecs.filter((c) => /opus/i.test(c.mimeType));
  const rest = caps.codecs.filter((c) => !/opus/i.test(c.mimeType));
  try { transceiver.setCodecPreferences([...opus, ...rest]); } catch {}
}
