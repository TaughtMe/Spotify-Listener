'use strict';

/* ---------- Konstanten & State ---------- */

const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-recently-played',
].join(' ');

const API = 'https://api.spotify.com/v1';
const POLL_MS = 5000;
const DEFAULT_KEYWORDS = ['kapitel', 'chapter', 'hörbuch', 'hoerbuch', 'audiobook', 'prolog', 'epilog'];
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');

const DEFAULT_STATE = {
  clientId: '',
  tokens: null, // { access, refresh, expires }
  keywords: DEFAULT_KEYWORDS,
  books: {}, // key: album-URI
  ignored: [], // album-URIs, die nicht als Hörbuch vorgeschlagen werden sollen
};

let state = loadState();
let candidate = null; // erkannter, noch nicht gespeicherter Titel
let nowPlaying = null;

function loadState() {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem('hm-state') || '{}') };
  } catch {
    return { ...DEFAULT_STATE };
  }
}
function saveState() {
  localStorage.setItem('hm-state', JSON.stringify(state));
}

/* ---------- Kleine Helfer ---------- */

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const hh = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function fmtAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  return `vor ${Math.round(hrs / 24)} Tagen`;
}

/* ---------- Spotify-Login (Authorization Code + PKCE) ---------- */

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function startLogin() {
  const verifier = randomString(64);
  localStorage.setItem('hm-verifier', verifier);
  const params = new URLSearchParams({
    client_id: state.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await sha256Base64Url(verifier),
  });
  location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: state.clientId, ...body }),
  });
  if (!res.ok) throw new Error(`Token-Anfrage fehlgeschlagen (${res.status})`);
  const j = await res.json();
  state.tokens = {
    access: j.access_token,
    refresh: j.refresh_token || state.tokens?.refresh,
    expires: Date.now() + (j.expires_in - 60) * 1000,
  };
  saveState();
}

async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  history.replaceState({}, '', REDIRECT_URI);
  if (params.has('error')) {
    toast(`Spotify-Login abgebrochen: ${params.get('error')}`);
    return;
  }
  try {
    await tokenRequest({
      grant_type: 'authorization_code',
      code: params.get('code'),
      redirect_uri: REDIRECT_URI,
      code_verifier: localStorage.getItem('hm-verifier') || '',
    });
    localStorage.removeItem('hm-verifier');
    toast('Mit Spotify verbunden ✓');
  } catch (e) {
    toast(e.message);
  }
}

async function accessToken() {
  if (!state.tokens) return null;
  if (Date.now() >= state.tokens.expires) {
    try {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: state.tokens.refresh });
    } catch {
      state.tokens = null;
      saveState();
      return null;
    }
  }
  return state.tokens.access;
}

/* ---------- Spotify-API ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  if (!token) throw Object.assign(new Error('Nicht angemeldet'), { status: 401 });
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = new Error(`Spotify-API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ---------- Hörbuch-Erkennung & Tracking ---------- */

function looksLikeAudiobook(track) {
  const hay = `${track.name} ${track.album?.name || ''}`.toLowerCase();
  return state.keywords.some((k) => k && hay.includes(k.toLowerCase()));
}

function snapshot(track, positionMs, contextUri) {
  return {
    trackUri: track.uri,
    trackId: track.id,
    trackName: track.name,
    trackNumber: track.track_number,
    discNumber: track.disc_number,
    durationMs: track.duration_ms,
    positionMs,
    contextUri: contextUri || null,
    updatedAt: Date.now(),
  };
}

function bookFromTrack(track, positionMs, contextUri) {
  return {
    albumUri: track.album.uri,
    albumName: track.album.name,
    cover: track.album.images?.[1]?.url || track.album.images?.[0]?.url || '',
    artist: track.artists?.map((a) => a.name).join(', ') || '',
    ...snapshot(track, positionMs, contextUri),
  };
}

async function poll() {
  if (document.hidden || !state.tokens) return;
  let r;
  try {
    r = await api('/me/player/currently-playing');
  } catch (e) {
    if (e.status === 401) renderAuthState();
    return;
  }

  const track = r?.item;
  if (!track || track.type !== 'track') {
    nowPlaying = null;
    candidate = null;
    renderNowPlaying();
    return;
  }

  nowPlaying = { track, playing: r.is_playing };
  const key = track.album.uri;
  const book = state.books[key];

  if (book) {
    Object.assign(book, snapshot(track, r.progress_ms, r.context?.uri));
    saveState();
    candidate = null;
  } else if (!state.ignored.includes(key) && looksLikeAudiobook(track)) {
    candidate = { track, progress: r.progress_ms, contextUri: r.context?.uri };
  } else {
    candidate = null;
  }
  renderNowPlaying();
  renderBooks();
}

// Beim Öffnen: Kapitel nachtragen, die gehört wurden, während die App zu war (ohne Minute).
async function catchUpFromHistory() {
  if (!state.tokens || !Object.keys(state.books).length) return;
  try {
    const { items } = await api('/me/player/recently-played?limit=50');
    const seen = new Set();
    let changed = false;
    for (const it of items) { // neueste zuerst
      const key = it.track.album.uri;
      const book = state.books[key];
      if (!book || seen.has(key)) continue;
      seen.add(key);
      if (it.track.uri !== book.trackUri && Date.parse(it.played_at) > book.updatedAt) {
        Object.assign(book, snapshot(it.track, 0, it.context?.uri));
        book.approx = true;
        changed = true;
      }
    }
    if (changed) { saveState(); renderBooks(); }
  } catch { /* nicht kritisch */ }
}

/* ---------- Abspielen ---------- */

function buildPlayBody(book) {
  const body = { position_ms: Math.max(0, book.positionMs - 2000) }; // 2 s Rücklauf zum Wiedereinstieg
  const ctx = book.contextUri;
  if (ctx && /^spotify:(album|playlist):/.test(ctx)) {
    body.context_uri = ctx;
    body.offset = { uri: book.trackUri };
  } else {
    body.context_uri = book.albumUri;
    body.offset = { uri: book.trackUri };
  }
  return body;
}

async function playBook(book) {
  const body = buildPlayBody(book);
  try {
    await api('/me/player/play', { method: 'PUT', body });
  } catch (e) {
    if (e.status === 404) return playOnAnyDevice(book, body);
    if (e.status === 403) return toast('Abspielen nicht erlaubt – Spotify Premium nötig?');
    if (e.status === 401) return toast('Bitte neu anmelden.');
    return toast(`Fehler: ${e.message}`);
  }
  openSpotifyApp();
}

async function playOnAnyDevice(book, body) {
  try {
    const { devices } = await api('/me/player/devices');
    const dev = devices.find((d) => d.is_active) || devices[0];
    if (dev) {
      await api(`/me/player/play?device_id=${dev.id}`, { method: 'PUT', body });
      return openSpotifyApp();
    }
  } catch { /* weiter mit Deep-Link */ }
  // Kein aktives Gerät: Spotify per Deep-Link wecken und nochmal versuchen.
  toast('Öffne Spotify …');
  location.href = book.trackUri;
  setTimeout(async () => {
    try {
      const { devices } = await api('/me/player/devices');
      if (!devices.length) throw new Error('kein Gerät');
      await api(`/me/player/play?device_id=${devices[0].id}`, { method: 'PUT', body });
    } catch {
      toast('Kein Spotify-Gerät gefunden. Starte Spotify einmal manuell und versuch es erneut.', 6000);
    }
  }, 3500);
}

function openSpotifyApp() {
  setTimeout(() => { location.href = 'spotify://'; }, 400);
}

/* ---------- Rendering ---------- */

function renderNowPlaying() {
  const box = $('nowPlaying');
  if (!candidate) { box.hidden = true; return; }
  const { track, progress, contextUri } = candidate;
  box.hidden = false;
  box.replaceChildren(
    h('div', { class: 'label' }, 'Läuft gerade – Hörbuch?'),
    h('div', { class: 'title' }, track.album.name),
    h('div', { class: 'chapter' }, `${track.name} · ${fmtTime(progress)}`),
    h('div', { class: 'row' },
      h('button', {
        class: 'primary',
        onclick: () => {
          state.books[track.album.uri] = bookFromTrack(track, progress, contextUri);
          saveState(); candidate = null; renderNowPlaying(); renderBooks();
          toast('Hörbuch wird jetzt gemerkt ✓');
        },
      }, 'Als Hörbuch merken'),
      h('button', {
        onclick: () => {
          state.ignored.push(track.album.uri);
          saveState(); candidate = null; renderNowPlaying();
        },
      }, 'Ist Musik'),
    ),
  );
}

function renderBooks() {
  const list = Object.values(state.books).sort((a, b) => b.updatedAt - a.updatedAt);
  $('empty').hidden = list.length > 0;
  $('books').replaceChildren(...list.map((b) => {
    const live = nowPlaying?.track.album.uri === b.albumUri && nowPlaying.playing;
    return h('div', { class: 'card' },
      b.cover ? h('img', { src: b.cover, alt: '', loading: 'lazy' }) : h('div', { class: 'cover' }),
      h('div', { class: 'info' },
        h('div', { class: 'title' }, b.albumName),
        h('div', { class: 'chapter' }, b.trackName),
        h('div', { class: 'meta' },
          `Nr. ${b.trackNumber} · ${b.approx ? 'Kapitelanfang' : fmtTime(b.positionMs)} · ${live ? '▶ läuft' : fmtAgo(b.updatedAt)}`),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'primary play', 'aria-label': 'Fortsetzen', onclick: () => playBook(b) }, '▶'),
        h('button', {
          class: 'danger', 'aria-label': 'Entfernen',
          onclick: () => {
            if (!confirm(`„${b.albumName}“ nicht mehr merken?`)) return;
            delete state.books[b.albumUri];
            saveState(); renderBooks();
          },
        }, '✕'),
      ),
    );
  }));
}

function renderAuthState() {
  $('authState').textContent = state.tokens
    ? 'Status: mit Spotify verbunden.'
    : 'Status: nicht angemeldet.';
}

/* ---------- Einstellungen ---------- */

function setupSettings() {
  const dlg = $('settings');
  $('settingsBtn').addEventListener('click', () => {
    $('clientId').value = state.clientId;
    $('redirectUri').value = REDIRECT_URI;
    $('keywords').value = state.keywords.join(', ');
    renderAuthState();
    dlg.showModal();
  });
  $('redirectUri').addEventListener('click', (e) => e.target.select());

  $('saveBtn').addEventListener('click', async () => {
    const id = $('clientId').value.trim();
    if (!id) return toast('Bitte Client-ID eintragen.');
    state.clientId = id;
    state.keywords = $('keywords').value.split(',').map((s) => s.trim()).filter(Boolean);
    saveState();
    dlg.close();
    await startLogin();
  });

  $('logoutBtn').addEventListener('click', () => {
    state.tokens = null;
    saveState();
    renderAuthState();
    toast('Abgemeldet. Gespeicherte Hörbücher bleiben erhalten.');
  });
}

/* ---------- Start ---------- */

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setupSettings();
  await handleRedirect();
  renderBooks();

  if (!state.clientId || !state.tokens) {
    $('settingsBtn').click();
  } else {
    catchUpFromHistory();
    poll();
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { catchUpFromHistory(); poll(); }
  });
}

init();
