import { Call, DEFAULT_ICE } from './call.js';
import { PRESETS, AUTO, levelOf, mbPerHour } from './quality.js';
import { newRoomCode, fmtDuration, fmtBytes } from './util.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- settings ----------

const SETTINGS_KEY = 'duet:settings';
const settings = Object.assign(
  { quality: AUTO, ns: true, ec: true, agc: true, turnUrl: '', turnUser: '', turnPass: '' },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'),
);
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

function bindSetting(id, key, prop = 'value') {
  const el = $(id);
  el[prop] = settings[key];
  el.addEventListener('change', () => {
    settings[key] = el[prop];
    saveSettings();
    if (call && prop === 'checked') {
      const map = { ns: 'noiseSuppression', ec: 'echoCancellation', agc: 'autoGainControl' };
      if (map[key]) call.setAudioOption(map[key], el.checked);
    }
  });
}
bindSetting('optNs', 'ns', 'checked');
bindSetting('optEc', 'ec', 'checked');
bindSetting('optAgc', 'agc', 'checked');
bindSetting('turnUrl', 'turnUrl');
bindSetting('turnUser', 'turnUser');
bindSetting('turnPass', 'turnPass');

function iceServers() {
  const list = [...DEFAULT_ICE];
  if (settings.turnUrl.trim()) {
    list.push({ urls: settings.turnUrl.trim(), username: settings.turnUser, credential: settings.turnPass });
  }
  return list;
}

// ---------- ui helpers ----------

function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
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

async function share(text, url) {
  if (navigator.share) {
    try { await navigator.share({ title: 'Duet call', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url || text, 'Copied — paste it in any chat');
}

const baseUrl = () => location.origin + location.pathname;

// ---------- quality sheet ----------

function presetById(id) { return PRESETS[levelOf(id)]; }

function renderQualityLabels() {
  let name, hint;
  if (call && call.effLevel != null) {
    const p = PRESETS[call.effLevel];
    name = (settings.quality === AUTO ? 'Auto · ' : '') + p.name;
  } else if (settings.quality === AUTO) {
    name = 'Auto';
    hint = 'Adjusts to your connection';
  } else {
    const p = presetById(settings.quality);
    name = p.name;
    hint = `${p.hint} · ≈${mbPerHour(p)} MB/hour`;
  }
  $$('[data-quality-name]').forEach((el) => { el.textContent = name; });
  $$('[data-quality-hint]').forEach((el) => { el.textContent = hint || ''; });
}

function renderQualityList() {
  const list = $('qualityList');
  list.innerHTML = '';
  const opts = [{ id: AUTO, name: 'Auto (recommended)', hint: 'Picks the best quality your network can hold', meta: 'adaptive' },
    ...[...PRESETS].reverse().map((p) => ({ id: p.id, name: p.name, hint: p.hint, meta: `${p.kbps} kbps<br>≈${mbPerHour(p)} MB/h` }))];
  for (const o of opts) {
    const b = document.createElement('button');
    b.className = 'qopt';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.quality === o.id));
    b.innerHTML = `<strong></strong><span class="meta">${o.meta}</span><span class="hint"></span>`;
    b.querySelector('strong').textContent = o.name;
    b.querySelector('.hint').textContent = o.hint;
    b.onclick = () => {
      settings.quality = o.id;
      saveSettings();
      if (call && call.state !== 'ended') call.setQuality(o.id);
      renderQualityLabels();
      closeSheets();
    };
    list.appendChild(b);
  }
  if (call && call.effLevel != null && call.peerLevel < call.myLevel) {
    const note = document.createElement('p');
    note.className = 'muted small';
    note.textContent = `The other person's connection is limiting the call to ${PRESETS[call.effLevel].name}.`;
    list.appendChild(note);
  }
}

function openSheet(id) { $(id).classList.remove('hidden'); }
function closeSheets() { $$('.sheet-backdrop').forEach((s) => s.classList.add('hidden')); }
$$('.sheet-backdrop').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) closeSheets(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
$$('[data-open-quality]').forEach((b) => b.addEventListener('click', () => { renderQualityList(); openSheet('qualitySheet'); }));

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
  call = new Call({
    quality: settings.quality,
    audio: { noiseSuppression: settings.ns, echoCancellation: settings.ec, autoGainControl: settings.agc },
    iceServers: iceServers(),
  });
  const c = call;
  c.addEventListener('state', (e) => { if (c === call) onState(e.detail); });
  c.addEventListener('remote', (e) => {
    const a = $('remoteAudio');
    a.srcObject = e.detail;
    a.play().catch(() => toast('Tap anywhere to enable sound'));
  });
  c.addEventListener('security', (e) => {
    $('securityCode').textContent = e.detail;
    $('securityRow').classList.remove('hidden');
  });
  c.addEventListener('quality', () => renderQualityLabels());
  c.addEventListener('stats', (e) => renderStats(e.detail));
  c.addEventListener('peermute', (e) => $('peerMuted').classList.toggle('hidden', !e.detail));
  c.addEventListener('relays', (e) => {
    if (c.state === 'waiting') $('lobbyStatus').textContent = e.detail ? `Encrypted relay ready (${e.detail} route${e.detail > 1 ? 's' : ''})` : 'Reconnecting to relay…';
  });
  resetCallUi();
  return c;
}

function resetCallUi() {
  $('securityRow').classList.add('hidden');
  $('peerMuted').classList.add('hidden');
  $('timer').textContent = '00:00';
  $('muteBtn').setAttribute('aria-pressed', 'false');
  $('muteBtn').querySelector('span').textContent = 'Mute';
  $('bars').dataset.n = '3';
  renderQualityLabels();
}

function onState({ state, info }) {
  switch (state) {
    case 'connecting-relay':
      $('lobbyStatus').textContent = 'Reaching encrypted relay…';
      break;
    case 'waiting':
      if (!call.manual) $('lobbyStatus').textContent = 'Encrypted relay ready';
      if (call.room && !$('lobby').classList.contains('active')) show('lobby'); // peer left before connecting
      break;
    case 'connecting':
      if (!call.manual) { show('call'); $('callStatus').textContent = 'Connecting…'; }
      else if (call.offerer) toast('Connecting…');
      break;
    case 'connected':
      show('call');
      $('callStatus').textContent = 'Connected';
      startTimer();
      startMeters();
      keepAwake();
      break;
    case 'reconnecting':
      $('callStatus').textContent = 'Reconnecting…';
      $('bars').dataset.n = '1';
      break;
    case 'retrying':
      $('callStatus').textContent = 'Trying another route…';
      break;
    case 'failed':
      endUi('Couldn’t connect', info?.message || 'The connection could not be established.', info?.detail);
      call.end('failed');
      break;
    case 'ended': {
      if (info.reason === 'failed') return;
      const reasons = { remote: 'They hung up', lost: 'Connection lost', local: 'Call ended' };
      const parts = [];
      if (info.duration) parts.push(fmtDuration(info.duration));
      if (info.bytes) parts.push(fmtBytes(info.bytes) + ' used');
      endUi(reasons[info.reason] || 'Call ended', parts.join(' · '));
      break;
    }
  }
}

function endUi(title, detail, diag) {
  $('endDiag').textContent = diag || '';
  $('endDiag').classList.toggle('hidden', !diag);
  clearInterval(timerInt);
  cancelAnimationFrame(meterRaf);
  releaseWake();
  $('remoteAudio').srcObject = null;
  $('endTitle').textContent = title;
  $('endDetail').textContent = detail || '';
  $('againBtn').textContent = wasManual ? 'New private call' : 'Call again';
  show('ended');
}

function startTimer() {
  clearInterval(timerInt);
  const tick = () => { if (call?.connectedAt) $('timer').textContent = fmtDuration(Date.now() - call.connectedAt); };
  tick();
  timerInt = setInterval(tick, 1000);
}

function renderStats(s) {
  $('bars').dataset.n = String(s.bars);
  $('routeLabel').textContent = s.route === 'relay' ? 'Relayed' : 'P2P direct';
  $('sCodec').textContent = s.codec || '–';
  $('sRtt').textContent = s.rtt != null ? Math.round(s.rtt * 1000) + ' ms' : '–';
  $('sLoss').textContent = (Math.max(s.lossIn, s.lossOut || 0) * 100).toFixed(1) + '%';
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
  $('lobby').querySelector('.share').classList.toggle('hidden', !isHost);
  $('lobbyTitle').textContent = isHost ? 'Waiting for the other person…' : 'Joining call…';
  $('lobbyStatus').textContent = 'Starting microphone…';
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
  if (e.name === 'NotAllowedError') return 'Microphone access was blocked. Allow it in your browser settings.';
  if (e.name === 'NotFoundError') return 'No microphone found.';
  if (e.name === 'NotReadableError') return 'Your microphone is being used by another app.';
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
$('shareBtn').onclick = () => share('Join my private Duet call', $('shareLink').textContent);
$('joinBtn').onclick = () => {
  const inv = parseInvite($('joinInput').value);
  if (!inv) return toast('That doesn’t look like a Duet link or code');
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
  $('muteBtn').querySelector('span').textContent = m ? 'Unmute' : 'Mute';
};

$('statsBtn').onclick = () => {
  const hidden = $('statsPanel').classList.toggle('hidden');
  $('statsBtn').classList.toggle('active', !hidden);
};

const canPickOutput = 'setSinkId' in HTMLMediaElement.prototype;
if (!canPickOutput) $('speakerBtn').classList.add('hidden');
$('speakerBtn').onclick = async () => {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  const list = $('outputList');
  list.innerHTML = '';
  const current = $('remoteAudio').sinkId || 'default';
  for (const d of devices.length ? devices : [{ deviceId: 'default', label: 'Default' }]) {
    const b = document.createElement('button');
    b.className = 'qopt';
    b.setAttribute('aria-checked', String(d.deviceId === current));
    b.innerHTML = '<strong></strong>';
    b.querySelector('strong').textContent = d.label || 'Speaker';
    b.onclick = async () => {
      try { await $('remoteAudio').setSinkId(d.deviceId); } catch { toast('Could not switch output'); }
      closeSheets();
    };
    list.appendChild(b);
  }
  openSheet('outputSheet');
};

// Some mobile browsers need a gesture before audio can play.
document.addEventListener('click', () => {
  const a = $('remoteAudio');
  if (a.srcObject && a.paused) a.play().catch(() => {});
  audioCtx?.resume();
});

window.addEventListener('pagehide', () => { if (call && call.state !== 'ended') call.end('local'); });

// ---------- private (manual) mode ----------

$('privateBtn').onclick = () => openManual();

function openManual(offerCode) {
  wasManual = true;
  if (call && call.state !== 'ended') call.end('local');
  call = null;
  $('mOfferBox').classList.add('hidden');
  $('mAnswerBox').classList.add('hidden');
  $('mMakeOffer').disabled = false;
  $('mMakeAnswer').disabled = false;
  $('mAnswerIn').value = '';
  $('mOfferIn').value = offerCode || '';
  selectTab(offerCode ? 'mRespond' : 'mCreate');
  history.replaceState(null, '', location.pathname);
  show('manual');
}

function selectTab(id) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
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
    toast(micError(e) || 'Could not create invite', 4000);
    $('mMakeOffer').disabled = false;
  }
  $('mMakeOffer').textContent = 'Create invite';
};
$('mCopyOffer').onclick = () => copy($('mOffer').value, 'Invite link copied');
$('mShareOffer').onclick = () => share('Join my private Duet call (open the link, then send me the reply code)', $('mOffer').value);

$('mConnect').onclick = async () => {
  if (!call || !call.manual) return toast('Create an invite first');
  try { await call.acceptManualAnswer($('mAnswerIn').value); } catch { toast('That reply code is not valid'); }
};

$('mMakeAnswer').onclick = async () => {
  const inv = parseInvite($('mOfferIn').value);
  if (!inv?.manual) return toast('Paste the invite link or code you received');
  $('mMakeAnswer').disabled = true;
  try {
    const c = newCall();
    const ans = await c.acceptManualOffer(inv.manual);
    $('mAnswer').value = ans;
    $('mAnswerBox').classList.remove('hidden');
  } catch (e) {
    toast(micError(e) || 'That invite is not valid (or expired)', 4000);
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
renderQualityLabels();
route();
