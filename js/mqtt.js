// Minimal MQTT 3.1.1 client over WebSocket (QoS 0 only).
// Used purely as a dumb, public "mailbox" to exchange encrypted call setup
// messages. No audio ever goes through it.

const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function varint(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function packet(type, ...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const head = [type, ...varint(len)];
  const out = new Uint8Array(head.length + len);
  out.set(head, 0);
  let o = head.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class MqttClient {
  constructor(url, { keepalive = 45, timeout = 6000 } = {}) {
    this.url = url;
    this.keepalive = keepalive;
    this.timeout = timeout;
    this.onmessage = null; // (topic, Uint8Array) => void
    this.onclose = null;
    this.connected = false;
    this._buf = new Uint8Array(0);
    this._pid = 1;
    this._ping = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } this.close(); };
      const timer = setTimeout(() => fail(new Error('timeout ' + this.url)), this.timeout);
      let ws;
      try { ws = new WebSocket(this.url, ['mqtt']); } catch (e) { clearTimeout(timer); return reject(e); }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        const id = 'duet' + Math.random().toString(36).slice(2, 12);
        const vh = new Uint8Array([0, 4, 77, 81, 84, 84, 4, 0x02, this.keepalive >> 8, this.keepalive & 0xff]);
        ws.send(packet(0x10, vh, str(id)));
      };
      ws.onerror = () => { clearTimeout(timer); fail(new Error('ws error ' + this.url)); };
      ws.onclose = () => {
        clearTimeout(timer);
        const was = this.connected;
        this.connected = false;
        clearInterval(this._ping);
        if (!settled) fail(new Error('closed ' + this.url));
        else if (was && this.onclose) this.onclose();
      };
      ws.onmessage = (ev) => {
        this._feed(new Uint8Array(ev.data), (type, body) => {
          if (type === 2) { // CONNACK
            clearTimeout(timer);
            if (body[1] !== 0) return fail(new Error('refused ' + body[1]));
            this.connected = true;
            settled = true;
            this._ping = setInterval(() => this._send(new Uint8Array([0xc0, 0])), this.keepalive * 1000 * 0.8);
            resolve(this);
          } else if (type === 3) { // PUBLISH
            const tl = (body[0] << 8) | body[1];
            const topic = dec.decode(body.subarray(2, 2 + tl));
            const qos = (this._lastFlags >> 1) & 3;
            const payload = body.subarray(2 + tl + (qos ? 2 : 0));
            if (this.onmessage) this.onmessage(topic, payload);
          }
        });
      };
    });
  }

  _feed(chunk, handle) {
    const b = new Uint8Array(this._buf.length + chunk.length);
    b.set(this._buf); b.set(chunk, this._buf.length);
    let o = 0;
    while (b.length - o >= 2) {
      let mult = 1, len = 0, i = o + 1, byte;
      do {
        if (i >= b.length) { this._buf = b.slice(o); return; }
        byte = b[i++];
        len += (byte & 127) * mult;
        mult *= 128;
      } while (byte & 128);
      if (b.length - i < len) break;
      this._lastFlags = b[o] & 0x0f;
      handle(b[o] >> 4, b.subarray(i, i + len));
      o = i + len;
    }
    this._buf = b.slice(o);
  }

  _send(bytes) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
  }

  subscribe(topic) {
    const id = this._pid++ & 0xffff || 1;
    this._send(packet(0x82, new Uint8Array([id >> 8, id & 0xff]), str(topic), new Uint8Array([0])));
  }

  publish(topic, payload) {
    const data = typeof payload === 'string' ? enc.encode(payload) : payload;
    this._send(packet(0x30, str(topic), data));
  }

  close() {
    clearInterval(this._ping);
    this.connected = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      try { if (ws.readyState === 1) ws.send(new Uint8Array([0xe0, 0])); ws.close(); } catch {}
    }
  }
}
