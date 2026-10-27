# Duet — private peer-to-peer voice calls

A static web app for HD voice calls straight between two browsers. There is no backend, no accounts, no build step and no dependencies: just HTML, CSS and plain JavaScript modules. It runs on GitHub Pages, Vercel or any static host.

## How it works

| Part | What it does |
|---|---|
| **Audio** | WebRTC with the Opus codec, sent **directly peer-to-peer**. It is always encrypted with DTLS-SRTP (AES, hardware accelerated, so it adds microseconds of delay, not milliseconds). |
| **Finding each other** | The two browsers exchange setup messages through public MQTT brokers (EMQX and HiveMQ, used at the same time for redundancy). Every message is **AES-256-GCM encrypted** with a key derived (PBKDF2) from the room secret, which lives only in the link's `#hash` and is never sent to any server. The brokers see only random topic names and ciphertext. |
| **After connecting** | Signaling moves to a P2P data channel, so quality changes and mute state never touch a relay. |
| **Extra-private call** | Uses no relay at all. You swap two short codes or links yourselves, through any chat app. |
| **Security code** | Both screens show an 8-digit code derived from the two DTLS fingerprints. If the codes match, nobody is sitting in the middle of the call. |

## Interface

- An Apple-style design with **Light**, **Dark** and **Automatic** themes (Automatic follows the device), plus a **Larger text** option.
- Plain wording everywhere. Connection numbers, routes and data use are hidden unless you turn on **Show technical details** in Settings.
- An optional **name** is shown to the other person, with their initials on the call screen.
- **Text messages** during a call. They travel over the same encrypted P2P channel as call control (or the encrypted relay while connecting), show "Delivered" once received, and are never stored: they disappear when the call ends.

## Quality presets

Both sides automatically use the **lower** of their two choices, so one slow phone doesn't break the call for both people.

| Preset | Opus bitrate | Audio band | Packet | ≈ data/hour |
|---|---|---|---|---|
| Best | 96 kbps | 48 kHz fullband | 20 ms | ~105 MB |
| High | 40 kbps | 48 kHz fullband | 20 ms | ~34 MB |
| Standard | 24 kbps | 24 kHz | 20 ms | ~25 MB |
| Data saver | 14 kbps | 16 kHz wideband | 40 ms | ~14 MB |
| Lowest data | 8 kbps | 8 kHz | 60 ms | ~8 MB |

- **Automatic** (the default) starts from the Network Information API's hint, then moves up or down based on live packet loss, jitter and round-trip time.
- Every preset uses Opus **in-band FEC**, which recovers lost packets. Every preset except Best also uses **DTX**, which sends almost nothing while you're silent.
- Longer packets on the low presets cut header overhead, which costs about 16 kbps at 20 ms.
- Changing quality mid-call applies to both directions within about a second. There is no reconnect.

## Limits

- **Two people per call.**
- **Strict networks.** Some network pairs block direct P2P traffic, most often a phone on mobile data (carrier NAT) or an office firewall. On those, a TURN relay is needed. TURN only forwards the encrypted audio and can't decrypt it, and only **one** side of the call needs it. You can add one in two places:
  - **For everyone:** put credentials in [`js/config.js`](js/config.js). Free tiers include [ExpressTURN](https://www.expressturn.com) and [Metered](https://www.metered.ca/tools/openrelay/).
  - **Just for you:** use Settings → My own relay server in the app.

  When a call can't connect, the app retries once, then explains why in plain words. Turn on Settings → Show technical details to also see which routes each side found.
- **Public brokers and STUN.** The app uses Google and Cloudflare STUN servers and public MQTT brokers to find the other person. They never carry audio, and they only see encrypted setup data. If you need zero third parties at all, use an Extra-private call. Note that STUN is still used there to find your public address.

## Deploy

It's a static folder:

- **GitHub Pages:** push the files and enable Pages on the branch root.
- **Vercel:** run `vercel` in this folder (framework: "Other", no build command).

Browsers only allow microphone access over HTTPS (or on localhost).

## Run locally

```bash
python3 -m http.server 8080
```
