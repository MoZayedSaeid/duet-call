# Duet — private peer-to-peer voice calls

A static web app for HD voice calls straight between two browsers. There is no backend, no accounts, no build step and no dependencies: just HTML, CSS and plain JavaScript modules. It runs on GitHub Pages, Vercel or any static host.

## How it works

| Part | What it does |
|---|---|
| **Audio** | WebRTC with the Opus codec, sent **directly peer-to-peer**. It is always encrypted with DTLS-SRTP (AES, hardware accelerated, so it adds microseconds of delay, not milliseconds). |
| **Finding each other** | The two browsers exchange setup messages through public MQTT brokers (EMQX and HiveMQ, used at the same time for redundancy). Every message is **AES-256-GCM encrypted** with a key derived (PBKDF2) from the room secret, which lives only in the link's `#hash` and is never sent to any server. The brokers see only random topic names and ciphertext. |
| **After connecting** | Signaling moves to a P2P data channel, so quality changes and mute state never touch a relay. |
| **Private mode** | Uses no relay at all. You swap two short codes or links yourselves, through any chat app. |
| **Security code** | Both screens show an 8-digit code derived from the two DTLS fingerprints. If the codes match, nobody is sitting in the middle of the call. |

## Quality presets

Both sides automatically use the **lower** of their two choices, so one slow phone doesn't break the call for both people.

| Preset | Opus bitrate | Audio band | Packet | ≈ data/hour |
|---|---|---|---|---|
| Studio | 96 kbps | 48 kHz fullband | 20 ms | ~105 MB |
| HD voice | 40 kbps | 48 kHz fullband | 20 ms | ~34 MB |
| Balanced | 24 kbps | 24 kHz | 20 ms | ~25 MB |
| Data saver | 14 kbps | 16 kHz wideband | 40 ms | ~14 MB |
| Ultra low | 8 kbps | 8 kHz | 60 ms | ~8 MB |

- **Auto** (the default) starts from the Network Information API's hint, then moves up or down based on live packet loss, jitter and round-trip time.
- Every preset uses Opus **in-band FEC**, which recovers lost packets. Every preset except Studio also uses **DTX**, which sends almost nothing while you're silent.
- Longer packets on the low presets cut header overhead, which costs about 16 kbps at 20 ms.
- Changing quality mid-call applies to both directions within about a second. There is no reconnect.

## Limits

- **Two people per call.**
- **Strict networks.** About 10–15% of networks (some corporate firewalls, some carrier NATs) block direct P2P traffic. On those, a TURN relay is needed. You can enter your own TURN server under Settings. TURN still can't decrypt the audio.
- **Public brokers and STUN.** The app uses Google and Cloudflare STUN servers and public MQTT brokers to find the other person. They never carry audio, and they only see encrypted setup data. If you need zero third parties at all, use Private mode. Note that STUN is still used there to find your public address.

## Deploy

It's a static folder:

- **GitHub Pages:** push the files and enable Pages on the branch root.
- **Vercel:** run `vercel` in this folder (framework: "Other", no build command).

Browsers only allow microphone access over HTTPS (or on localhost).

## Run locally

```bash
python3 -m http.server 8080
```
