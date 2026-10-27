// WebRTC call engine. Audio goes directly peer-to-peer, encrypted with
// DTLS-SRTP (AES, hardware accelerated: adds microseconds, not milliseconds).

import { Room } from './signaling.js';
import { PRESETS, AUTO, levelOf, mungeSdp, preferOpus, initialAutoLevel, estimateKbps } from './quality.js';
import { compress, decompress, securityCode, fingerprintOf, randomId } from './util.js';
import { TURN_SERVERS } from './config.js';

export const DEFAULT_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  ...TURN_SERVERS,
];

const MAX_AUTO = 3; // Auto never goes above HD; Studio is opt-in

export class Call extends EventTarget {
  constructor({ quality = AUTO, audio = {}, iceServers = DEFAULT_ICE, brokers, name = '' } = {}) {
    super();
    this.name = name;
    this.mode = quality;
    this.autoLevel = initialAutoLevel();
    this.peerLevel = PRESETS.length - 1;
    this.effLevel = null;
    this.audioOpts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...audio };
    this.iceServers = iceServers;
    this.brokers = brokers;
    this.id = randomId(12);
    this.state = 'idle';
    this.pendingIce = [];
    this.stats = {};
    this._prev = null;
    this._bad = 0;
    this._good = 0;
    this._cooldown = 0;
    this.connectedAt = 0;
    this.everConnected = false;
  }

  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  setState(s, info) {
    this.state = s;
    this.emit('state', { state: s, info });
  }

  get myLevel() { return this.mode === AUTO ? this.autoLevel : levelOf(this.mode); }
  get preset() { return PRESETS[this.effLevel ?? Math.min(this.myLevel, this.peerLevel)]; }

  // ---------- microphone ----------

  async openMic() {
    if (this.localStream) return this.localStream;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { ...this.audioOpts, channelCount: 1, sampleRate: 48000 },
      video: false,
    });
    this.track = this.localStream.getAudioTracks()[0];
    try { this.track.contentHint = 'speech'; } catch {}
    return this.localStream;
  }

  async setAudioOption(key, value) {
    this.audioOpts[key] = value;
    if (this.track) {
      try { await this.track.applyConstraints({ ...this.audioOpts, channelCount: 1 }); } catch {}
    }
  }

  // Text messages ride the same encrypted channel as call setup: the P2P
  // data channel once connected, the encrypted relay before that.
  sendChat(id, text) {
    this.send({ type: 'chat', id, text });
  }

  setMuted(muted) {
    if (this.track) this.track.enabled = !muted;
    this.muted = muted;
    this.send({ type: 'mute', on: muted });
  }

  // ---------- room (link) mode ----------

  async joinRoom(secret) {
    await this.openMic();
    this.setState('connecting-relay');
    this.room = new Room(secret, this.brokers ? { brokers: this.brokers } : {});
    this.room.id = this.id;
    this.room.onmessage = (m) => this.onSignal(m, 'relay');
    this.room.onstatus = (n) => this.emit('relays', n);
    await this.room.join();
    this.setState('waiting');
    const hello = () => {
      if (this.state === 'ended') return;
      if (!this.everConnected || this.state === 'reconnecting') this.room.send({ type: 'hello', lvl: this.myLevel });
    };
    hello();
    this._helloTimer = setInterval(hello, 2500);
  }

  // ---------- private (manual, no relay) mode ----------

  async createManualOffer() {
    await this.openMic();
    this.manual = true;
    this.peer = 'manual';
    this.offerer = true;
    this.createPC();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitIce();
    this.setState('waiting');
    return 'D1' + await compress(JSON.stringify({ sdp: mungeSdp(this.pc.localDescription.sdp, this.preset), lvl: this.myLevel }));
  }

  async acceptManualOffer(code) {
    await this.openMic();
    const { sdp, lvl } = JSON.parse(await decompress(code.trim().replace(/^D1/, '')));
    this.manual = true;
    this.peer = 'manual';
    this.offerer = false;
    this.peerLevel = lvl ?? this.peerLevel;
    this.createPC();
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.attachTrackAsAnswerer();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitIce();
    this.setState('connecting');
    return 'A1' + await compress(JSON.stringify({ sdp: mungeSdp(this.pc.localDescription.sdp, this.preset), lvl: this.myLevel }));
  }

  async acceptManualAnswer(code) {
    const { sdp, lvl } = JSON.parse(await decompress(code.trim().replace(/^A1/, '')));
    this.peerLevel = lvl ?? this.peerLevel;
    this.setState('connecting');
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  waitIce(ms = 5000) {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      this.pc.addEventListener('icegatheringstatechange', () => {
        if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
      });
    });
  }

  // ---------- peer connection ----------

  createPC() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.pc = pc;
    this.dc = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
    this.dc.onmessage = (e) => { try { this.onSignal(JSON.parse(e.data), 'p2p'); } catch {} };
    this.dc.onopen = () => {
      this.send({ type: 'pref', lvl: this.myLevel });
      if (this.name) this.send({ type: 'name', name: this.name });
    };

    if (this.offerer) {
      const t = pc.addTransceiver(this.track, { direction: 'sendrecv', streams: [this.localStream] });
      preferOpus(t);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate && !this.manual) this.send({ type: 'ice', c: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.remoteStream = stream;
      this.emit('remote', stream);
    };
    this.armConnectTimeout();
    pc.onconnectionstatechange = () => this.onConnState();
    pc.oniceconnectionstatechange = () => {
      // Safari reports some transitions only here
      if (!pc.connectionState) this.onConnState(pc.iceConnectionState);
    };
  }

  // Browsers can sit in "connecting" forever if no usable route ever shows up.
  armConnectTimeout() {
    clearTimeout(this._connectTimer);
    this._connectTimer = setTimeout(() => {
      if (!this.everConnected && this.pc && this.state !== 'ended') this.onConnState('failed');
    }, 25000);
  }

  attachTrackAsAnswerer() {
    const t = this.pc.getTransceivers().find((x) => x.receiver.track && x.receiver.track.kind === 'audio');
    if (!t) return;
    t.sender.replaceTrack(this.track);
    if (t.sender.setStreams) try { t.sender.setStreams(this.localStream); } catch {}
    t.direction = 'sendrecv';
    preferOpus(t);
  }

  async onConnState(override) {
    const s = override || this.pc.connectionState;
    if (s === 'connected' || s === 'completed') {
      clearTimeout(this._restartTimer);
      clearTimeout(this._lostTimer);
      clearTimeout(this._connectTimer);
      if (!this.everConnected) {
        this.everConnected = true;
        this.connectedAt = Date.now();
        this.startStats();
        const code = await securityCode(
          fingerprintOf(this.pc.localDescription?.sdp), fingerprintOf(this.pc.remoteDescription?.sdp));
        this.emit('security', code);
      }
      this.setState('connected');
      this.applyEffective(true);
    } else if (s === 'disconnected' || s === 'failed') {
      if (!this.everConnected) {
        if (s !== 'failed') return;
        if (!this._retried && !this.manual) {
          // One ICE restart: recovers lost candidates or a slow network.
          this._retried = true;
          this.setState('retrying');
          this.armConnectTimeout();
          if (this.offerer) this.negotiate(true);
          else this.send({ type: 'restart' });
          return;
        }
        this.setState('failed', await this.diagnose());
        return;
      }
      this.setState('reconnecting');
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => this.iceRestart(), s === 'failed' ? 0 : 3000);
      if (!this._lostTimer) this._lostTimer = setTimeout(() => {
        this._lostTimer = null;
        if (this.state === 'reconnecting') this.end('lost');
      }, 45000);
    }
  }

  // Explain WHY the direct connection failed, from the candidates both sides found.
  async diagnose() {
    const local = new Set(), remote = new Set();
    let pairs = 0;
    try {
      (await this.pc.getStats()).forEach((x) => {
        if (x.type === 'local-candidate') local.add(x.candidateType);
        else if (x.type === 'remote-candidate') remote.add(x.candidateType);
        else if (x.type === 'candidate-pair') pairs++;
      });
    } catch {}
    const names = { host: 'local', srflx: 'public', prflx: 'public', relay: 'TURN relay' };
    const list = (set) => [...set].map((t) => names[t] || t).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'none';
    const why = !remote.size
      ? 'We couldn’t reach the other person. Ask them to reload the page, or try switching between Wi-Fi and mobile data.'
      : 'One of your networks is blocking the call. Try switching between Wi-Fi and mobile data.';
    return { message: why, detail: `Your routes: ${list(local)} · their routes: ${list(remote)} · ${pairs} paths tried` };
  }

  iceRestart() {
    if (this.state !== 'reconnecting' || this.manual) return;
    if (this.offerer) this.negotiate(true);
    else this.send({ type: 'restart' });
  }

  async negotiate(iceRestart = false) {
    if (!this.offerer || !this.pc) return;
    if (this._making) { this._again = { iceRestart: iceRestart || this._again?.iceRestart }; return; }
    this._making = true;
    try {
      if (this.pc.signalingState !== 'stable') return;
      const offer = await this.pc.createOffer({ iceRestart });
      await this.pc.setLocalDescription(offer);
      this.sendSdp();
    } catch (e) {
      console.warn('negotiate', e);
    } finally {
      this._making = false;
      if (this._again) { const a = this._again; this._again = null; this.negotiate(a.iceRestart); }
    }
  }

  sendSdp() {
    const d = this.pc.localDescription;
    this._lastSdpSent = Date.now();
    this.effLevel = Math.min(this.myLevel, this.peerLevel);
    // We munge only what we SEND: it tells the other side's encoder how to
    // encode audio for us. Local descriptions stay untouched (no browser quirks).
    this.send({ type: 'sdp', sdp: { type: d.type, sdp: mungeSdp(d.sdp, this.preset) } });
  }

  // ---------- signaling messages ----------

  send(msg) {
    msg = { ...msg, to: this.peer, lvl: this.myLevel };
    const p2pOk = this.dc && this.dc.readyState === 'open';
    const healthy = this.state === 'connected';
    if (p2pOk) { try { this.dc.send(JSON.stringify(msg)); } catch {} }
    if (this.room && (!p2pOk || !healthy || msg.type === 'bye')) this.room.send(msg);
  }

  async onSignal(m, via) {
    if (this.state === 'ended') return;
    if (via === 'relay') {
      if (this.peer && m.from !== this.peer) {
        const stale = Date.now() - (this._peerSeen || 0) > 8000;
        if (m.type === 'hello' && this.state !== 'connected' && stale) {
          this.resetPeer(); // old peer vanished (e.g. reloaded); take the new one
        } else {
          if (m.type === 'hello') this.room.send({ type: 'busy', to: m.from });
          return;
        }
      }
      this._peerSeen = Date.now();
    }
    if (typeof m.lvl === 'number' && m.lvl !== this.peerLevel) {
      this.peerLevel = m.lvl;
      if (this.pc) this.applyEffective();
    }

    switch (m.type) {
      case 'hello':
        if (!this.peer) {
          this.peer = m.from;
          this.offerer = this.id > m.from;
          this.setState('connecting');
          this.createPC();
          if (this.offerer) this.negotiate();
        } else if (this.offerer && this.pc?.signalingState === 'have-local-offer' && Date.now() - this._lastSdpSent > 4000) {
          this.sendSdp(); // our offer may have been lost; resend
        }
        break;
      case 'busy':
        if (!this.peer) this.setState('failed', { message: 'Two people are already on this call. Start a new one instead.' });
        break;
      case 'sdp':
        await this.onRemoteSdp(m.sdp);
        break;
      case 'ice':
        if (!this.pc) break;
        if (this.pc.remoteDescription) { try { await this.pc.addIceCandidate(m.c); } catch {} }
        else this.pendingIce.push(m.c);
        break;
      case 'restart':
        if (this.offerer) this.negotiate(true);
        break;
      case 'mute':
        this.emit('peermute', !!m.on);
        break;
      case 'chat':
        if (typeof m.id === 'string' && typeof m.text === 'string') {
          this.send({ type: 'chat-ack', id: m.id });
          this.emit('chat', { id: m.id.slice(0, 32), text: m.text.slice(0, 2000) });
        }
        break;
      case 'chat-ack':
        if (typeof m.id === 'string') this.emit('chatack', m.id);
        break;
      case 'name':
        if (typeof m.name === 'string') this.emit('peername', m.name.trim().slice(0, 40));
        break;
      case 'bye':
        this.end('remote');
        break;
    }
  }

  async onRemoteSdp(desc) {
    if (!this.pc) return;
    try {
      if (desc.type === 'offer') {
        if (this.offerer) return; // only one side ever offers: no glare
        if (this._lastOffer === desc.sdp && this.pc.signalingState === 'stable' && this.pc.localDescription) {
          return this.sendSdp(); // duplicate offer: our answer was lost
        }
        this._lastOffer = desc.sdp;
        const first = !this.pc.remoteDescription;
        await this.pc.setRemoteDescription(desc);
        if (first) this.attachTrackAsAnswerer();
        await this.flushIce();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSdp();
      } else if (desc.type === 'answer') {
        if (this.pc.signalingState !== 'have-local-offer') return;
        await this.pc.setRemoteDescription(desc);
        await this.flushIce();
      }
    } catch (e) {
      console.warn('sdp', e);
    }
  }

  async flushIce() {
    const q = this.pendingIce;
    this.pendingIce = [];
    for (const c of q) { try { await this.pc.addIceCandidate(c); } catch {} }
  }

  resetPeer() {
    if (this.pc) this.pc.close();
    this.pc = null;
    this.dc = null;
    this.peer = null;
    this.pendingIce = [];
    this._lastOffer = null;
    this._retried = false;
    clearTimeout(this._connectTimer);
    this.everConnected = false;
    this.effLevel = null;
    this._prev = null;
    clearInterval(this._statsTimer);
    clearTimeout(this._restartTimer);
    clearTimeout(this._lostTimer);
    this._lostTimer = null;
    this.setState('waiting');
  }

  // ---------- quality ----------

  setQuality(mode) {
    this.mode = mode;
    if (mode === AUTO) { this._good = this._bad = 0; }
    this.send({ type: 'pref' });
    this.applyEffective();
  }

  async applyEffective(force = false) {
    if (!this.pc) return;
    const eff = Math.min(this.myLevel, this.peerLevel);
    if (eff === this.effLevel && !force) return;
    const changed = eff !== this.effLevel;
    this.effLevel = eff;
    const p = PRESETS[eff];
    const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (sender) {
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = p.kbps * 1000 + 2000;
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        await sender.setParameters(params);
      } catch (e) { /* Firefox before negotiation etc. */ }
    }
    this.emit('quality', { preset: p, level: eff, mine: this.myLevel, peer: this.peerLevel, auto: this.mode === AUTO });
    // Renegotiate so the other side's encoder also switches bandwidth/packet size.
    if (changed && this.offerer && this.state === 'connected') this.negotiate();
  }

  // ---------- stats + auto quality ----------

  startStats() {
    clearInterval(this._statsTimer);
    this._statsTimer = setInterval(() => this.pollStats(), 2000);
  }

  async pollStats() {
    if (!this.pc || this.state === 'ended') return;
    const r = await this.pc.getStats();
    const now = performance.now();
    const s = { inbound: null, outbound: null, remoteIn: null, pair: null, local: null, remote: null, codec: null };
    let pairId = null;
    r.forEach((x) => {
      if (x.type === 'inbound-rtp' && x.kind === 'audio') s.inbound = x;
      else if (x.type === 'outbound-rtp' && x.kind === 'audio') s.outbound = x;
      else if (x.type === 'remote-inbound-rtp' && x.kind === 'audio') s.remoteIn = x;
      else if (x.type === 'transport' && x.selectedCandidatePairId) pairId = x.selectedCandidatePairId;
      else if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded' && !pairId) s.pair = x;
    });
    if (pairId) s.pair = r.get(pairId);
    if (s.pair) {
      s.local = r.get(s.pair.localCandidateId);
      s.remote = r.get(s.pair.remoteCandidateId);
    }
    if (s.inbound?.codecId) s.codec = r.get(s.inbound.codecId);

    const prev = this._prev;
    const out = {
      rtt: s.pair?.currentRoundTripTime ?? s.remoteIn?.roundTripTime ?? null,
      jitter: s.inbound?.jitter ?? null,
      lossIn: 0,
      lossOut: s.remoteIn?.fractionLost ?? null,
      kbpsIn: 0, kbpsOut: 0,
      bytes: (s.pair?.bytesSent || 0) + (s.pair?.bytesReceived || 0),
      route: s.local?.candidateType === 'relay' || s.remote?.candidateType === 'relay' ? 'relay' : 'direct',
      net: s.local?.networkType || '',
      codec: s.codec ? `${s.codec.mimeType.split('/')[1]} ${Math.round(s.codec.clockRate / 1000)}k` : '',
      available: s.pair?.availableOutgoingBitrate ?? null,
    };
    if (prev && s.inbound && prev.inbound) {
      const dt = (now - prev.t) / 1000;
      const dl = (s.inbound.packetsLost || 0) - (prev.inbound.packetsLost || 0);
      const dr = (s.inbound.packetsReceived || 0) - (prev.inbound.packetsReceived || 0);
      out.lossIn = dl + dr > 0 ? Math.max(0, dl) / (dl + dr) : 0;
      out.kbpsIn = ((s.inbound.bytesReceived - prev.inbound.bytesReceived) * 8) / 1000 / dt;
      if (s.outbound && prev.outbound) out.kbpsOut = ((s.outbound.bytesSent - prev.outbound.bytesSent) * 8) / 1000 / dt;
    }
    this._prev = { t: now, inbound: s.inbound, outbound: s.outbound };

    const loss = Math.max(out.lossIn, out.lossOut || 0);
    const rtt = out.rtt ?? 0;
    const jit = out.jitter ?? 0;
    out.bars = loss > 0.1 || rtt > 0.8 ? 1 : loss > 0.03 || rtt > 0.35 || jit > 0.04 ? 2 : 3;
    this.stats = out;
    this.emit('stats', out);
    if (this.mode === AUTO && this.state === 'connected') this.autoTune(out, loss, rtt, jit);
  }

  autoTune(out, loss, rtt, jit) {
    if (this._cooldown > 0) { this._cooldown--; return; }
    // availableOutgoingBitrate is only a downgrade hint (often absent for audio)
    const bad = loss > 0.08 || rtt > 0.6 || jit > 0.06 ||
      (out.available > 0 && out.available < estimateKbps(PRESETS[this.autoLevel]) * 1000 * 0.9);
    const good = loss < 0.02 && rtt < 0.3 && jit < 0.03;
    if (bad) { this._bad++; this._good = 0; } else if (good) { this._good++; this._bad = 0; } else { this._good = 0; }
    let next = this.autoLevel;
    if (this._bad >= 2 && next > 0) next--;
    else if (this._good >= 6 && next < MAX_AUTO) next++;
    if (next !== this.autoLevel) {
      this.autoLevel = next;
      this._bad = this._good = 0;
      this._cooldown = 3;
      this.send({ type: 'pref' });
      this.applyEffective();
    }
  }

  // ---------- teardown ----------

  end(reason = 'local') {
    if (this.state === 'ended') return;
    if (reason === 'local') this.send({ type: 'bye' });
    const duration = this.connectedAt ? Date.now() - this.connectedAt : 0;
    const bytes = this.stats.bytes || 0;
    clearInterval(this._helloTimer);
    clearInterval(this._statsTimer);
    clearTimeout(this._connectTimer);
    clearTimeout(this._restartTimer);
    clearTimeout(this._lostTimer);
    this.setState('ended', { reason, duration, bytes });
    // let the bye message flush before tearing down
    setTimeout(() => {
      if (this.pc) this.pc.close();
      if (this.room) this.room.leave();
      if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    }, 300);
  }
}
