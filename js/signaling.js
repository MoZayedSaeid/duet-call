// Serverless signaling: peers meet on public MQTT brokers, but every message
// is AES-256-GCM encrypted with a key derived from the room secret that only
// lives in the link's #hash (never sent to any server). Brokers only ever see
// random topic names and ciphertext. Once the call is up, signaling moves to
// the peer-to-peer data channel.

import { MqttClient } from './mqtt.js';
import { b64u, unb64u, randomId } from './util.js';

export const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker-cn.emqx.io:8084/mqtt',
];

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveRoom(secret) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('duet-room-v1'), iterations: 150000 }, base, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const topic = 'duet/v1/' + b64u(bits.slice(32, 56));
  return { key, topic };
}

export class Room {
  constructor(secret, { brokers = DEFAULT_BROKERS } = {}) {
    this.secret = secret;
    this.brokers = brokers;
    this.id = randomId(12);
    this.clients = [];
    this.seen = new Set();
    this.onmessage = null; // (msg) => void
    this.onstatus = null;  // (connectedCount) => void
    this.closed = false;
  }

  async join() {
    const { key, topic } = await deriveRoom(this.secret);
    this.key = key;
    this.topic = topic;
    const attempts = this.brokers.map((url) => this._connect(url));
    // Resolve as soon as ONE broker is up; others join in the background.
    await Promise.any(attempts).catch(() => {
      throw new Error('Can’t connect right now. Check your internet and try again.');
    });
  }

  async _connect(url, retry = 0) {
    if (this.closed) return;
    const c = new MqttClient(url);
    try {
      await c.connect();
    } catch (e) {
      if (retry < 2 && !this.closed) {
        await new Promise((r) => setTimeout(r, 2000 * (retry + 1)));
        return this._connect(url, retry + 1);
      }
      throw e;
    }
    if (this.closed) return c.close();
    c.onmessage = (_t, payload) => this._receive(payload);
    c.onclose = () => {
      this.clients = this.clients.filter((x) => x !== c);
      this._status();
      if (!this.closed) setTimeout(() => this._connect(url).catch(() => {}), 3000);
    };
    c.subscribe(this.topic);
    this.clients.push(c);
    this._status();
    return c;
  }

  _status() {
    if (this.onstatus) this.onstatus(this.clients.length);
  }

  async _receive(payload) {
    try {
      const raw = unb64u(dec.decode(payload));
      const iv = raw.slice(0, 12);
      const tag = b64u(iv);
      if (this.seen.has(tag)) return; // same message via another broker
      this.seen.add(tag);
      if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-500));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.key, raw.slice(12));
      const msg = JSON.parse(dec.decode(plain));
      if (msg.from === this.id) return;
      if (msg.to && msg.to !== this.id) return;
      if (Math.abs(Date.now() - msg.ts) > 120000) return; // stale / replayed
      if (this.onmessage) this.onmessage(msg);
    } catch {
      // Not for us (wrong key) or garbage: ignore silently.
    }
  }

  async send(msg) {
    if (!this.key) return;
    const body = enc.encode(JSON.stringify({ ...msg, from: this.id, ts: Date.now() }));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, body));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    this.seen.add(b64u(iv));
    const text = b64u(out);
    for (const c of this.clients) c.publish(this.topic, text);
  }

  leave() {
    this.closed = true;
    for (const c of this.clients) c.close();
    this.clients = [];
  }
}
