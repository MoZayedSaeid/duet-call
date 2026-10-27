import { Call, DEFAULT_ICE } from './call.js';
import { PRESETS, AUTO, levelOf, mbPerHour } from './quality.js';
import { newRoomCode, fmtDuration, fmtBytes } from './util.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- settings ----------

const SETTINGS_KEY = 'duet:settings';
const settings = Object.assign(
  {
    quality: AUTO, ns: true, ec: true, agc: true, turnUrl: '', turnUser: '', turnPass: '',
    theme: 'auto', largeText: false, tech: false, name: '',
  },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'),
);
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

function bindSetting(id, key, prop = 'value', onChange) {
  const el = $(id);
  el[prop] = settings[key];
  el.addEventListener(prop === 'checked' ? 'change' : 'input', () => {
    settings[key] = el[prop];
    saveSettings();
    onChange?.(el[prop]);
  });
}
const liveAudio = (opt) => (on) => { if (call) call.setAudioOption(opt, on); };
bindSetting('optNs', 'ns', 'checked', liveAudio('noiseSuppression'));
bindSetting('optEc', 'ec', 'checked', liveAudio('echoCancellation'));
bindSetting('optAgc', 'agc', 'checked', liveAudio('autoGainControl'));
bindSetting('optLarge', 'largeText', 'checked', applyAppearance);
bindSetting('optTech', 'tech', 'checked', applyTech);
bindSetting('myName', 'name', 'value', renderGreeting);
bindSetting('turnUrl', 'turnUrl', 'value', renderRelayState);
bindSetting('turnUser', 'turnUser');
bindSetting('turnPass', 'turnPass');

function iceServers() {
  const list = [...DEFAULT_ICE];
  if (settings.turnUrl.trim()) {
    list.push({ urls: settings.turnUrl.trim(), username: settings.turnUser, credential: settings.turnPass });
  }
  return list;
}

// ---------- appearance ----------

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyAppearance() {
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  if (settings.largeText) root.dataset.text = 'large';
  else delete root.dataset.text;
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && darkQuery.matches);
  $('themeColor').content = dark ? '#000000' : '#f2f2f7';
  $$('[data-theme-pick]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themePick === settings.theme)));
}
darkQuery.addEventListener('change', applyAppearance);
$$('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => {
  settings.theme = b.dataset.themePick;
  saveSettings();
  applyAppearance();
}));

function applyTech() {
  $('statsPanel').classList.toggle('hidden', !settings.tech);
  $('endDiag').classList.toggle('hidden', !settings.tech || !$('endDiag').textContent);
  if (call?.stats) renderStats(call.stats);
}

function renderGreeting() {
  const first = settings.name.trim().split(/\s+/)[0];
  $('greeting').textContent = first ? `Hi, ${first}` : 'Duet';
}

function renderRelayState() {
  $('relayState').textContent = settings.turnUrl.trim() ? 'On' : 'Not set';
}

$('relayToggle').onclick = () => {
  const open = $('relayFields').classList.toggle('hidden') === false;
  $('relayToggle').setAttribute('aria-expanded', String(open));
};

$('settingsBtn').onclick = () => show('settings');
$$('[data-close-settings]').forEach((b) => b.addEventListener('click', () => show('home')));

// ---------- ui helpers ----------

function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  document.body.classList.toggle('in-call', id === 'call');
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label);
}

const canShare = !!navigator.share;
async function share(text, url) {
  if (canShare) {
    try { await navigator.share({ title: 'Duet call', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url || text, 'Copied. Paste it in any chat.');
}
// Without a share menu, "Copy" becomes the main button.
if (!canShare) {
  for (const [s, c] of [['shareBtn', 'copyBtn'], ['mShareOffer', 'mCopyOffer'], ['mShareAnswer', 'mCopyAnswer']]) {
    $(s).classList.add('hidden');
    $(c).classList.add('primary');
  }
}

const baseUrl = () => location.origin + location.pathname;

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => [...p][0].toUpperCase()).join('');
}

// ---------- sound quality sheet ----------

function presetById(id) { return PRESETS[levelOf(id)]; }

function renderQualityLabels() {
  let name, short;
  if (call && call.effLevel != null) {
    const p = PRESETS[call.effLevel];
    name = (settings.quality === AUTO ? 'Automatic · ' : '') + p.name;
    short = p.name;
  } else if (settings.quality === AUTO) {
    name = 'Automatic';
    short = 'Quality';
  } else {
    name = short = presetById(settings.quality).name;
  }
  $$('[data-quality-name]').forEach((el) => { el.textContent = name; });
  $$('[data-quality-short]').forEach((el) => { el.textContent = short; });
}

function renderQualityList() {
  const list = $('qualityList');
  list.innerHTML = '';
  const opts = [
    { id: AUTO, name: 'Automatic', hint: 'Best sound your internet can handle', meta: settings.tech ? 'adaptive' : '' },
    ...[...PRESETS].reverse().map((p) => ({
      id: p.id, name: p.name, hint: p.hint,
      meta: `≈${mbPerHour(p)} MB/hour` + (settings.tech ? ` · ${p.kbps} kbps` : ''),
    })),
  ];
  for (const o of opts) {
    const b = document.createElement('button');
    b.className = 'cell';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.quality === o.id));
    b.innerHTML = '<span class="grow"><span class="title"></span><span class="sub"></span></span><span class="meta"></span>'
      + '<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" /></svg>';
    b.querySelector('.title').textContent = o.name;
    b.querySelector('.sub').textContent = o.hint;
    b.querySelector('.meta').textContent = o.meta;
    b.onclick = () => {
      settings.quality = o.id;
      saveSettings();
      if (call && call.state !== 'ended') call.setQuality(o.id);
      renderQualityLabels();
      closeSheets();
    };
    list.appendChild(b);
  }
  const foot = $('qualityFoot');
  foot.textContent = call && call.effLevel != null && call.peerLevel < call.myLevel
    ? `The other person’s internet is slower, so you’re both using ${PRESETS[call.effLevel].name}.`
    : 'Lower quality uses less data and stays smooth on slow internet. If the other person picks lower, you’ll both use theirs.';
}

function openSheet(id) { $(id).classList.remove('hidden'); }
function closeSheets() { $$('.sheet-backdrop').forEach((s) => s.classList.add('hidden')); }
$$('.sheet-backdrop').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) closeSheets(); }));
$$('[data-close-sheet]').forEach((b) => b.addEventListener('click', closeSheets));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
$$('[data-open-quality]').forEach((b) => b.addEventListener('click', () => { renderQualityList(); openSheet('qualitySheet'); }));
$('securityRow').onclick = () => openSheet('privacySheet');

// ---------- call wiring ----------

let call = null;
let lastRoom = null;
let wasManual = false;
let wakeLock = null;
let meterRaf = 0;
let audioCtx = null;
let localAnalyser = null;
let timerInt = 0;

function newCall() {
  if (call && call.state !== 'ended') call.end();
  setLoudspeaker(false); // phones start on the earpiece; must be set before the mic opens
  call = new Call({
    quality: settings.quality,
    audio: { noiseSuppression: settings.ns, echoCancellation: settings.ec, autoGainControl: settings.agc },
    iceServers: iceServers(),
    name: settings.name.trim(),
  });
  const c = call;
  c.addEventListener('state', (e) => { if (c === call) onState(e.detail); });
  c.addEventListener('remote', (e) => {
    const a = $('remoteAudio');
    a.srcObject = e.detail;
    a.play().catch(() => toast('Tap anywhere to turn on sound'));
  });
  c.addEventListener('security', (e) => {
    $('securityCode').textContent = e.detail;
    $('securityRow').classList.remove('hidden');
  });
  c.addEventListener('quality', () => renderQualityLabels());
  c.addEventListener('stats', (e) => renderStats(e.detail));
  c.addEventListener('peermute', (e) => $('peerMuted').classList.toggle('hidden', !e.detail));
  c.addEventListener('peername', (e) => setPeerName(e.detail));
  c.addEventListener('relays', (e) => {
    if (c.state === 'waiting') setLobbyStatus(!!e.detail);
  });
  resetCallUi();
  return c;
}

function setLobbyStatus(ready) {
  const host = !$('shareCard').classList.contains('hidden');
  $('lobbyStatus').textContent = !ready ? 'Reconnecting…' : host ? 'Your link is ready to send' : 'Waiting for the other person…';
  $('lobbyDot').classList.toggle('ok', ready);
}

function setPeerName(name) {
  const ini = name ? initials(name) : '';
  $('peerName').textContent = name || 'Voice call';
  $('peerInitials').textContent = ini;
  $('peerInitials').classList.toggle('hidden', !ini);
  $('peerIcon').classList.toggle('hidden', !!ini);
}

function resetCallUi() {
  $('securityRow').classList.add('hidden');
  $('peerMuted').classList.add('hidden');
  $('callStatus').textContent = 'Connecting…';
  $('routeLabel').textContent = 'Connecting';
  $('muteBtn').setAttribute('aria-pressed', 'false');
  $('muteLabel').textContent = 'Mute';
  $('bars').dataset.n = '3';
  $('call').dataset.state = '';
  setPeerName('');
  ['sRoute', 'sRtt', 'sLoss', 'sJitter', 'sRate', 'sData'].forEach((id) => { $(id).textContent = '–'; });
  applyTech();
  renderQualityLabels();
}

function onState({ state, info }) {
  $('call').dataset.state = state;
  switch (state) {
    case 'connecting-relay':
      $('lobbyStatus').textContent = 'Getting ready…';
      $('lobbyDot').classList.remove('ok');
      break;
    case 'waiting':
      if (!call.manual) setLobbyStatus(true);
      if (call.room && !$('lobby').classList.contains('active')) show('lobby'); // they left before connecting
      break;
    case 'connecting':
      if (!call.manual) { show('call'); $('callStatus').textContent = 'Connecting…'; }
      else if (call.offerer) toast('Connecting…');
      break;
    case 'connected':
      show('call');
      startTimer();
      startMeters();
      keepAwake();
      break;
    case 'reconnecting':
      clearInterval(timerInt);
      $('callStatus').textContent = 'Reconnecting…';
      $('routeLabel').textContent = 'Weak connection';
      $('bars').dataset.n = '1';
      break;
    case 'retrying':
      $('callStatus').textContent = 'Still trying…';
      break;
    case 'failed':
      endUi('Couldn’t connect', info?.message || 'Something went wrong. Please try again.', info?.detail, true);
      call.end('failed');
      break;
    case 'ended': {
      if (info.reason === 'failed') return;
      const reasons = { remote: 'They hung up', lost: 'Call dropped', local: 'Call ended' };
      const parts = [];
      if (info.reason === 'lost') parts.push('The internet connection was lost.');
      if (info.duration) parts.push(fmtDuration(info.duration));
      if (info.bytes && settings.tech) parts.push(fmtBytes(info.bytes) + ' used');
      endUi(reasons[info.reason] || 'Call ended', parts.join(' · '), '', info.reason === 'lost');
      break;
    }
  }
}

function endUi(title, detail, diag, bad = false) {
  $('endDiag').textContent = diag || '';
  clearInterval(timerInt);
  cancelAnimationFrame(meterRaf);
  releaseWake();
  closeSheets();
  $('remoteAudio').srcObject = null;
  $('endTitle').textContent = title;
  $('endDetail').textContent = detail || '';
  $('endAvatar').classList.toggle('red', bad);
  $('againBtn').textContent = bad ? 'Try again' : wasManual ? 'New private call' : 'Call again';
  applyTech();
  show('ended');
}

function startTimer() {
  clearInterval(timerInt);
  const tick = () => { if (call?.connectedAt) $('callStatus').textContent = fmtDuration(Date.now() - call.connectedAt); };
  tick();
  timerInt = setInterval(tick, 1000);
}

function renderStats(s) {
  if (!s || s.bars == null) return;
  $('bars').dataset.n = String(s.bars);
  const words = { 1: 'Weak connection', 2: 'Fair connection', 3: 'Good connection' };
  const direct = s.route === 'relay' ? 'Relayed' : 'Direct';
  $('routeLabel').textContent = words[s.bars] + (settings.tech ? ` · ${direct}` : '');
  $('sRoute').textContent = direct;
  $('sRtt').textContent = s.rtt != null ? Math.round(s.rtt * 1000) + ' ms' : '–';
  $('sLoss').textContent = (Math.max(s.lossIn || 0, s.lossOut || 0) * 100).toFixed(1) + '%';
  $('sJitter').textContent = s.jitter != null ? Math.round(s.jitter * 1000) + ' ms' : '–';
  $('sRate').textContent = `${Math.round(s.kbpsOut)} / ${Math.round(s.kbpsIn)} kbps`;
  $('sData').textContent = fmtBytes(s.bytes);
}

// ---------- level meters (cheap: no remote audio processing) ----------

function startMeters() {
  cancelAnimationFrame(meterRaf);
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(call.localStream);
    localAnalyser = audioCtx.createAnalyser();
    localAnalyser.fftSize = 512;
    src.connect(localAnalyser);
  } catch { localAnalyser = null; }
  const buf = new Float32Array(512);
  const ring = $('remoteRing');
  const bar = $('localMeter');
  let smooth = 0;
  const loop = () => {
    if (!call || call.state === 'ended') return;
    if (localAnalyser && !call.muted) {
      localAnalyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      bar.style.width = Math.min(100, Math.sqrt(sum / buf.length) * 400) + '%';
    } else bar.style.width = '0%';
    let lvl = 0;
    const rcv = call.pc?.getReceivers().find((r) => r.track?.kind === 'audio');
    if (rcv?.getSynchronizationSources) {
      const src = rcv.getSynchronizationSources()[0];
      if (src && performance.timeOrigin + performance.now() - src.timestamp < 500) lvl = src.audioLevel || 0;
    }
    smooth = Math.max(lvl * 2.2, smooth * 0.88);
    ring.style.opacity = Math.min(1, smooth * 1.5).toFixed(2);
    ring.style.transform = `scale(${(1 + Math.min(0.18, smooth * 0.25)).toFixed(3)})`;
    meterRaf = requestAnimationFrame(loop);
  };
  meterRaf = requestAnimationFrame(loop);
}

// ---------- screen wake lock (keeps mobile calls alive) ----------

async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  wakeLock = null;
  if (document.visibilityState === 'visible' && call?.state === 'connected') keepAwake();
});

// ---------- room flow ----------

async function startRoom(code, isHost) {
  wasManual = false;
  lastRoom = code;
  history.replaceState(null, '', '#r=' + code);
  const link = baseUrl() + '#r=' + code;
  $('shareLink').textContent = link;
  $('shareCard').classList.toggle('hidden', !isHost);
  $('lobbyTitle').textContent = isHost ? 'Waiting for them to join' : 'Joining the call…';
  $('lobbyStatus').textContent = 'Turning on your microphone…';
  $('lobbyDot').classList.remove('ok');
  show('lobby');
  const c = newCall();
  try {
    await c.joinRoom(code);
  } catch (e) {
    c.end('failed');
    show('home');
    toast(micError(e) || e.message, 4500);
  }
}

function micError(e) {
  if (e.name === 'NotAllowedError') return 'Duet needs your microphone. Allow it in your browser settings, then try again.';
  if (e.name === 'NotFoundError') return 'No microphone found. Plug one in and try again.';
  if (e.name === 'NotReadableError') return 'Another app is using your microphone. Close it and try again.';
  return '';
}

function parseInvite(text) {
  text = text.trim();
  const p = /#p=([\w-]+)/.exec(text);
  if (p) return { manual: p[1] };
  const r = /#r=([\w-]+)/.exec(text);
  if (r) return { room: r[1] };
  if (/^D1[\w-]{40,}$/.test(text)) return { manual: text };
  if (/^[\w-]{8,}$/.test(text)) return { room: text };
  return null;
}

$('startBtn').onclick = () => startRoom(newRoomCode(), true);
$('copyBtn').onclick = () => copy($('shareLink').textContent, 'Link copied');
$('shareBtn').onclick = () => share('Join my Duet call', $('shareLink').textContent);
$('joinBtn').onclick = () => {
  const inv = parseInvite($('joinInput').value);
  if (!inv) return toast('That link doesn’t look right. Try copying it again.');
  $('joinInput').value = '';
  if (inv.manual) return openManual(inv.manual);
  startRoom(inv.room, false);
};
$('joinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
$('acceptBtn').onclick = () => { const inv = parseInvite(location.hash); if (inv?.room) startRoom(inv.room, false); };

$$('[data-hangup]').forEach((b) => b.addEventListener('click', () => {
  if (call && call.state !== 'ended') {
    const wasLive = call.everConnected;
    call.end('local');
    if (!wasLive) goHome();
  } else goHome();
}));
$$('[data-home]').forEach((b) => b.addEventListener('click', goHome));

function goHome() {
  if (call && call.state !== 'ended') call.end('local');
  call = null;
  history.replaceState(null, '', location.pathname);
  renderQualityLabels();
  show('home');
}

$('againBtn').onclick = () => {
  if (wasManual) return openManual();
  if (lastRoom) startRoom(lastRoom, true);
};

// ---------- in-call controls ----------

$('muteBtn').onclick = () => {
  if (!call) return;
  const m = !call.muted;
  call.setMuted(m);
  $('muteBtn').setAttribute('aria-pressed', String(m));
  $('muteLabel').textContent = m ? 'Unmute' : 'Mute';
};

// ---------- speaker / earpiece ----------
// iPhone Safari (iOS 17+): a "play-and-record" audio session plays the call from
// the top earpiece, like a phone call; "auto" lets Safari use the loudspeaker.
// Android Chrome always uses the loudspeaker for web calls, and pages can't change it.
const isIPhone = /iPhone|iPod/.test(navigator.userAgent);
const isAndroid = /Android/.test(navigator.userAgent);
const canEarpiece = isIPhone && 'audioSession' in navigator;
const canPickOutput = !isAndroid && 'setSinkId' in HTMLMediaElement.prototype;

function setLoudspeaker(on) {
  if (!canEarpiece) return;
  try { navigator.audioSession.type = on ? 'auto' : 'play-and-record'; } catch {}
  $('speakerBtn').setAttribute('aria-pressed', String(on));
}

$('speakerBtn').onclick = async () => {
  if (canEarpiece) {
    const on = $('speakerBtn').getAttribute('aria-pressed') !== 'true';
    setLoudspeaker(on);
    return toast(on ? 'Speaker on' : 'Speaker off. Hold the phone to your ear.');
  }
  if (!canPickOutput) {
    return toast(isAndroid
      ? 'Phone browsers always use the loudspeaker for web calls. Use headphones for a private call.'
      : isIPhone ? 'Update your iPhone to iOS 17 or later to switch between earpiece and speaker.'
        : 'Your browser chooses the speaker by itself.', 5000);
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  const list = $('outputList');
  list.innerHTML = '';
  const current = $('remoteAudio').sinkId || 'default';
  for (const d of devices.length ? devices : [{ deviceId: 'default', label: 'This device' }]) {
    const b = document.createElement('button');
    b.className = 'cell';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(d.deviceId === current));
    b.innerHTML = '<span class="grow"><span class="title"></span></span><svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" /></svg>';
    b.querySelector('.title').textContent = d.deviceId === 'default' ? 'This device' : d.label || 'Speaker';
    b.onclick = async () => {
      try { await $('remoteAudio').setSinkId(d.deviceId); } catch { toast('Couldn’t switch the speaker'); }
      closeSheets();
    };
    list.appendChild(b);
  }
  openSheet('outputSheet');
};

// Some mobile browsers need a tap before audio can play.
document.addEventListener('click', () => {
  const a = $('remoteAudio');
  if (a.srcObject && a.paused) a.play().catch(() => {});
  audioCtx?.resume();
});

window.addEventListener('pagehide', () => { if (call && call.state !== 'ended') call.end('local'); });

// ---------- extra-private (manual codes) mode ----------

$('privateBtn').onclick = () => openManual();

function openManual(offerCode) {
  wasManual = true;
  if (call && call.state !== 'ended') call.end('local');
  call = null;
  $('mOfferBox').classList.add('hidden');
  $('mAnswerBox').classList.add('hidden');
  $('mMakeOffer').classList.remove('hidden');
  $('mMakeOffer').disabled = false;
  $('mMakeAnswer').disabled = false;
  $('mAnswerIn').value = '';
  $('mOfferIn').value = offerCode || '';
  selectTab(offerCode ? 'mRespond' : 'mCreate');
  history.replaceState(null, '', location.pathname);
  show('manual');
}

function selectTab(id) {
  $$('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === id);
    t.setAttribute('aria-selected', String(t.dataset.tab === id));
  });
  $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === id));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

$('mMakeOffer').onclick = async () => {
  $('mMakeOffer').disabled = true;
  $('mMakeOffer').textContent = 'Preparing…';
  try {
    const c = newCall();
    const code = await c.createManualOffer();
    $('mOffer').value = baseUrl() + '#p=' + code;
    $('mOfferBox').classList.remove('hidden');
    $('mMakeOffer').classList.add('hidden');
  } catch (e) {
    toast(micError(e) || 'Couldn’t create the invite. Please try again.', 4000);
    $('mMakeOffer').disabled = false;
  }
  $('mMakeOffer').textContent = 'Create invite';
};
$('mCopyOffer').onclick = () => copy($('mOffer').value, 'Invite copied');
$('mShareOffer').onclick = () => share('Join my private Duet call. Open the link, then send me the reply.', $('mOffer').value);

$('mConnect').onclick = async () => {
  if (!call || !call.manual) return toast('Create an invite first');
  try { await call.acceptManualAnswer($('mAnswerIn').value); } catch { toast('That reply doesn’t look right. Try copying it again.'); }
};

$('mMakeAnswer').onclick = async () => {
  const inv = parseInvite($('mOfferIn').value);
  if (!inv?.manual) return toast('Paste the invite you received first');
  $('mMakeAnswer').disabled = true;
  try {
    const c = newCall();
    const ans = await c.acceptManualOffer(inv.manual);
    $('mAnswer').value = ans;
    $('mAnswerBox').classList.remove('hidden');
  } catch (e) {
    toast(micError(e) || 'That invite doesn’t work. Ask them for a new one.', 4000);
    $('mMakeAnswer').disabled = false;
  }
};
$('mCopyAnswer').onclick = () => copy($('mAnswer').value, 'Reply copied');
$('mShareAnswer').onclick = () => share($('mAnswer').value);

// ---------- routing ----------

function route() {
  const inv = parseInvite(location.hash);
  if (inv?.manual) return openManual(inv.manual);
  if (inv?.room) { show('invite'); return; }
  show('home');
}
window.addEventListener('hashchange', () => { if (!call || call.state === 'ended') route(); });
setLoudspeaker(false);
applyAppearance();
renderGreeting();
renderRelayState();
renderQualityLabels();
route();
