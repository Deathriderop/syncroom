/* SyncRoom client
   - Music: YouTube IFrame Player, driven by sync events from the server.
     The server never touches audio — it only relays play/pause/seek/track
     timestamps, so YouTube streams audio directly to this browser at full quality.
   - Calls: WebRTC mesh (each peer connects directly to each other peer).
     Audio/video never passes through our server either.
*/

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const socket = io();
let myId = null;
let roomId = null;
let myName = null;

// If the socket ever drops and reconnects (network blip, tab backgrounded,
// host going to sleep, etc.) socket.io gives us a fresh connection but the
// server has no memory of which room we were in. Without re-joining, this
// client silently stops sending/receiving sync events even though the UI
// still looks normal. So: whenever we (re)connect and we already know which
// room we're in, tell the server again.
socket.on('connect', () => {
  myId = socket.id;
  if (roomId && myName) {
    socket.emit('join-room', { roomId, name: myName });
  }
});

let ytPlayer = null;
let ytReady = false;
let pendingVideoId = null;

let queue = [];
let currentIndex = -1;
let isPlayingState = false;

let localStream = null;
const peers = new Map(); // socketId -> { pc, name, tile, stream }
const DRIFT_TOLERANCE = 0.6; // seconds before we force a reseek

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const generateCodeBtn = document.getElementById('generate-code-btn');
const ytApiKeyInput = document.getElementById('yt-api-key-input');

const roomNameLabel = document.getElementById('room-name-label');
const tilesEl = document.getElementById('tiles');
const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const leaveBtn = document.getElementById('leave-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');

const vinyl = document.getElementById('vinyl');
const dialOrbit = document.getElementById('dial-orbit');
const nowPlayingTitle = document.getElementById('now-playing-title');
const playPauseBtn = document.getElementById('play-pause-btn');
const nextBtn = document.getElementById('next-btn');
const seekBar = document.getElementById('seek-bar');
const unlockAudioBtn = document.getElementById('unlock-audio-btn');
let audioUnlocked = false;
const timeCurrent = document.getElementById('time-current');
const timeDuration = document.getElementById('time-duration');
const addTrackForm = document.getElementById('add-track-form');
const addTrackInput = document.getElementById('add-track-input');
const queueListEl = document.getElementById('queue-list');

const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

// Restore saved API key
ytApiKeyInput.value = localStorage.getItem('syncroom_yt_key') || '';

// Let people know if this server already has a shared key configured,
// so most visitors never need to paste their own in at all.
const serverKeyStatusEl = document.getElementById('server-key-status');
fetch('/api/youtube/config')
  .then(r => r.json())
  .then(({ hasServerKey }) => {
    serverKeyStatusEl.textContent = hasServerKey
      ? '✓ This server already has a shared key configured — search and playlist import work with no key from you.'
      : 'No shared key configured on this server yet. Playing single tracks works with no key either way. To import playlists or search, paste a YouTube Data API v3 key below — it stays only in your browser.';
  })
  .catch(() => {
    serverKeyStatusEl.textContent = 'Playing single tracks works with no key. To import a whole playlist or search, paste a YouTube Data API v3 key here — it stays only in your browser.';
  });

// ---------------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------------
generateCodeBtn.addEventListener('click', () => {
  const words = ['sunset', 'echo', 'amber', 'nova', 'drift', 'quiet', 'static', 'lounge', 'harbor', 'ember'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  roomInput.value = `${pick()}-${pick()}-${Math.floor(Math.random() * 90 + 10)}`;
});

// Pre-fill room from URL (?room=xyz) for invite links
const urlParams = new URLSearchParams(location.search);
if (urlParams.get('room')) roomInput.value = urlParams.get('room');

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  myName = nameInput.value.trim();
  roomId = roomInput.value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!myName || !roomId) return;

  localStorage.setItem('syncroom_yt_key', ytApiKeyInput.value.trim());

  joinScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  unlockAudioBtn.classList.remove('hidden');
  roomNameLabel.textContent = roomId;
  history.replaceState(null, '', `?room=${encodeURIComponent(roomId)}`);

  initLocalMedia().finally(() => {
    socket.emit('join-room', { roomId, name: myName });
  });
});

copyLinkBtn.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => (copyLinkBtn.textContent = 'Copy invite'), 1500);
  } catch {
    prompt('Copy this invite link:', url);
  }
});

leaveBtn.addEventListener('click', () => location.reload());

// ---------------------------------------------------------------------------
// Local media (mic/cam) — off by default, user opts in
// ---------------------------------------------------------------------------
async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // start muted until user hits the mic button, but keep the track ready
    localStream.getAudioTracks().forEach(t => (t.enabled = false));
  } catch (err) {
    console.warn('Mic permission not granted yet:', err.message);
    localStream = new MediaStream(); // empty; peers just won't get audio until enabled
  }
}

micBtn.addEventListener('click', async () => {
  const on = micBtn.getAttribute('data-on') === 'true';
  if (!localStream || localStream.getAudioTracks().length === 0) await initLocalMedia();
  localStream.getAudioTracks().forEach(t => (t.enabled = !on));
  micBtn.setAttribute('data-on', String(!on));
  socket.emit('presence:update', { mic: !on });
  renderMyTile();
});

camBtn.addEventListener('click', async () => {
  const on = camBtn.getAttribute('data-on') === 'true';
  if (!on) {
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = camStream.getVideoTracks()[0];
      localStream.addTrack(track);
      peers.forEach(({ pc }) => pc.addTrack(track, localStream));
    } catch (err) {
      alert('Could not access camera: ' + err.message);
      return;
    }
  } else {
    localStream.getVideoTracks().forEach(t => {
      t.stop();
      localStream.removeTrack(t);
    });
  }
  camBtn.setAttribute('data-on', String(!on));
  socket.emit('presence:update', { cam: !on });
  renderMyTile();
});

// ---------------------------------------------------------------------------
// WebRTC mesh
// ---------------------------------------------------------------------------
function createPeerConnection(peerId, name) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const entry = { pc, name, stream: new MediaStream() };
  peers.set(peerId, entry);

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('webrtc:ice', { to: peerId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    entry.stream.addTrack(e.track);
    renderPeerTile(peerId);
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      renderPeerTile(peerId);
    }
  };

  return entry;
}

async function callPeer(peerId, name) {
  const { pc } = createPeerConnection(peerId, name);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc:offer', { to: peerId, offer });
}

socket.on('peer-joined', ({ id, name }) => {
  // We were already here, so we initiate the connection to the newcomer.
  callPeer(id, name);
});

socket.on('webrtc:offer', async ({ from, offer }) => {
  const existing = peers.get(from);
  const { pc } = existing || createPeerConnection(from, existing?.name || 'Guest');
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc:answer', { to: from, answer });
});

socket.on('webrtc:answer', async ({ from, answer }) => {
  const entry = peers.get(from);
  if (entry) await entry.pc.setRemoteDescription(answer);
});

socket.on('webrtc:ice', async ({ from, candidate }) => {
  const entry = peers.get(from);
  if (entry) {
    try { await entry.pc.addIceCandidate(candidate); } catch (err) { console.warn(err); }
  }
});

socket.on('peer-left', ({ id }) => {
  const entry = peers.get(id);
  if (entry) {
    entry.pc.close();
    peers.delete(id);
  }
  document.getElementById(`tile-${id}`)?.remove();
});

// ---------------------------------------------------------------------------
// Room state / tiles / presence
// ---------------------------------------------------------------------------
let membersById = new Map(); // id -> {name, mic, cam}

socket.on('room-state', (state) => {
  myId = socket.id;
  queue = state.queue;
  currentIndex = state.currentIndex;
  isPlayingState = state.isPlaying;

  membersById = new Map(state.members.map(m => [m.id, m]));
  renderAllTiles();
  renderQueue();

  if (queue[currentIndex]) {
    loadTrackWhenReady(queue[currentIndex].videoId, state.position, state.isPlaying, state.updatedAt);
  }

  // Connect to peers already in the room (they won't re-offer to us since
  // 'peer-joined' already fired for them before we existed)
  state.members.forEach(m => {
    if (m.id !== myId && !peers.has(m.id)) {
      // The existing peer will call us via 'peer-joined' on their side.
      // Nothing to do here — just make sure we render their tile.
    }
  });
});

socket.on('presence:update', ({ id, mic, cam }) => {
  const m = membersById.get(id) || { name: 'Guest' };
  membersById.set(id, { ...m, mic, cam });
  renderPeerTile(id);
});

function renderAllTiles() {
  tilesEl.innerHTML = '';
  membersById.forEach((m, id) => {
    if (id === myId) renderMyTile();
    else renderPeerTile(id);
  });
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function renderMyTile() {
  let tile = document.getElementById(`tile-${myId}`);
  const mic = micBtn.getAttribute('data-on') === 'true';
  const cam = camBtn.getAttribute('data-on') === 'true';
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `tile-${myId}`;
    tile.className = 'tile';
    tilesEl.prepend(tile);
  }
  tile.classList.toggle('speaking', mic);
  tile.innerHTML = `
    <div class="avatar">${initials(myName)}</div>
    <div class="who">
      <span class="name">${escapeHtml(myName)} (you)</span>
      <span class="status">${mic ? '🎙️ live' : 'muted'}${cam ? ' · cam on' : ''}</span>
    </div>`;
}

function renderPeerTile(id) {
  const m = membersById.get(id);
  const entry = peers.get(id);
  if (!m && !entry) return;
  const name = m?.name || entry?.name || 'Guest';
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `tile-${id}`;
    tile.className = 'tile';
    tilesEl.appendChild(tile);
  }
  tile.classList.toggle('speaking', !!m?.mic);
  const videoTrack = entry?.stream.getVideoTracks()[0];
  tile.innerHTML = `
    ${videoTrack ? '<video autoplay playsinline></video>' : `<div class="avatar">${initials(name)}</div>`}
    <div class="who">
      <span class="name">${escapeHtml(name)}</span>
      <span class="status">${m?.mic ? '🎙️ live' : 'muted'}${m?.cam ? ' · cam on' : ''}</span>
    </div>`;
  if (videoTrack) {
    const videoEl = tile.querySelector('video');
    videoEl.srcObject = new MediaStream([videoTrack]);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// YouTube player + sync
// ---------------------------------------------------------------------------
function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player('yt-player-mount', {
    height: '1', width: '1',
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, mute: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        if (pendingVideoId) {
          const { videoId, position, playing, updatedAt } = pendingVideoId;
          applyLoad(videoId, position, playing, updatedAt);
          pendingVideoId = null;
        }
      },
      onStateChange: onPlayerStateChange
    }
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function loadTrackWhenReady(videoId, position, playing, updatedAt) {
  if (ytReady) applyLoad(videoId, position, playing, updatedAt);
  else pendingVideoId = { videoId, position, playing, updatedAt };
}

function applyLoad(videoId, position, playing, updatedAt) {
  const elapsed = playing ? (Date.now() - updatedAt) / 1000 : 0;
  const startAt = Math.max(0, position + elapsed);
  ytPlayer.loadVideoById({ videoId, startSeconds: startAt });
  if (audioUnlocked && playing) ytPlayer.unMute();
  if (!playing) setTimeout(() => ytPlayer.pauseVideo(), 400);
  vinyl.classList.toggle('spinning', playing);
  nowPlayingTitle.textContent = (queue[currentIndex] && queue[currentIndex].title) || videoId;
  updatePlayPauseIcon(playing);
}

function onPlayerStateChange(e) {
  // We drive sync via socket events, not by re-broadcasting every native
  // player event, to avoid feedback loops between clients.
}

// --- unlock audio for this tab (browsers block unmuted programmatic
// playback unless it follows a real, synchronous user gesture; socket-
// driven play/pause/seek always arrive asynchronously, so without this
// step no client's audio ever actually starts) ---
unlockAudioBtn.addEventListener('click', () => {
  audioUnlocked = true;
  unlockAudioBtn.classList.add('hidden');
  if (ytPlayer && ytReady) {
    // A genuine unmuted play/pause inside this click "unlocks" the tab so
    // later programmatic (socket-triggered) playVideo() calls can have sound.
    ytPlayer.unMute();
    ytPlayer.playVideo();
    setTimeout(() => { if (!isPlayingState) ytPlayer.pauseVideo(); }, 250);
  }
});

// --- transport controls (any participant can control playback) ---
playPauseBtn.addEventListener('click', () => {
  if (!ytPlayer || currentIndex === -1) return;
  const pos = ytPlayer.getCurrentTime();
  // Act locally, synchronously, inside the click — don't wait on the
  // socket round trip, or the browser no longer counts this as a
  // user-gesture-triggered play and may block audio.
  if (isPlayingState) {
    isPlayingState = false;
    ytPlayer.pauseVideo();
    vinyl.classList.remove('spinning');
    updatePlayPauseIcon(false);
    socket.emit('music:pause', { position: pos });
  } else {
    isPlayingState = true;
    ytPlayer.unMute();
    ytPlayer.playVideo();
    vinyl.classList.add('spinning');
    updatePlayPauseIcon(true);
    socket.emit('music:play', { position: pos });
  }
});

nextBtn.addEventListener('click', () => socket.emit('queue:next'));

seekBar.addEventListener('change', () => {
  if (!ytPlayer) return;
  const duration = ytPlayer.getDuration() || 0;
  const pos = (seekBar.value / 100) * duration;
  socket.emit('music:seek', { position: pos });
});

socket.on('music:play', ({ position, updatedAt }) => {
  isPlayingState = true;
  if (ytPlayer) {
    ytPlayer.seekTo(position + (Date.now() - updatedAt) / 1000, true);
    if (audioUnlocked) ytPlayer.unMute();
    ytPlayer.playVideo();
  }
  vinyl.classList.add('spinning');
  updatePlayPauseIcon(true);
});

socket.on('music:pause', ({ position }) => {
  isPlayingState = false;
  if (ytPlayer) {
    ytPlayer.seekTo(position, true);
    ytPlayer.pauseVideo();
  }
  vinyl.classList.remove('spinning');
  updatePlayPauseIcon(false);
});

socket.on('music:seek', ({ position, updatedAt }) => {
  if (!ytPlayer) return;
  const target = position + (isPlayingState ? (Date.now() - updatedAt) / 1000 : 0);
  ytPlayer.seekTo(target, true);
});

socket.on('music:load-index', ({ index, videoId, updatedAt }) => {
  currentIndex = index;
  isPlayingState = true;
  renderQueue();
  loadTrackWhenReady(videoId, 0, true, updatedAt);
});

socket.on('queue:update', ({ queue: q, currentIndex: ci }) => {
  queue = q;
  currentIndex = ci;
  renderQueue();
});

function updatePlayPauseIcon(playing) {
  playPauseBtn.textContent = playing ? '⏸' : '▶';
}

// Periodic drift correction + progress bar update
setInterval(() => {
  if (!ytPlayer || !ytPlayer.getCurrentTime || currentIndex === -1) return;
  const duration = ytPlayer.getDuration() || 0;
  const current = ytPlayer.getCurrentTime() || 0;
  if (duration > 0) {
    seekBar.value = Math.min(100, (current / duration) * 100);
    timeCurrent.textContent = formatTime(current);
    timeDuration.textContent = formatTime(duration);
  }
}, 500);

function formatTime(s) {
  s = Math.floor(s);
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

// ---------------------------------------------------------------------------
// Queue UI + adding tracks / playlists
// ---------------------------------------------------------------------------
function renderQueue() {
  queueListEl.innerHTML = '';
  queue.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = i === currentIndex ? 'active' : '';
    li.innerHTML = `<span class="qi">${i + 1}</span><span>${escapeHtml(item.title || item.videoId)}</span>`;
    li.addEventListener('click', () => socket.emit('music:load-index', { index: i }));
    queueListEl.appendChild(li);
  });
}

function extractVideoId(url) {
  const m = url.match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

function extractPlaylistId(url) {
  const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

addTrackForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = addTrackInput.value.trim();
  if (!raw) return;
  addTrackInput.value = '';

  const playlistId = extractPlaylistId(raw);
  if (playlistId) {
    await importPlaylist(playlistId);
    return;
  }
  const videoId = extractVideoId(raw);
  if (videoId) {
    const title = await fetchOEmbedTitle(videoId); // no API key needed, works for any public video
    socket.emit('queue:add', { videoId, title: title || videoId });
  } else {
    alert('Could not read a YouTube video or playlist link from that.');
  }
});

// oEmbed gives us a real title without needing an API key (works for single public videos)
async function fetchOEmbedTitle(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch {
    return null;
  }
}

async function importPlaylist(playlistId) {
  // 1) Try the server's shared key first — works for everyone, no setup needed.
  try {
    const res = await fetch(`/api/youtube/playlist?id=${encodeURIComponent(playlistId)}`);
    if (res.status !== 501) {
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.items || data.items.length === 0) {
        alert('No videos found in that playlist (it may be private).');
        return;
      }
      socket.emit('queue:add-many', { items: data.items });
      return;
    }
    // 501 = server has no shared key configured, fall through to personal key
  } catch (err) {
    console.warn('Shared-key playlist import failed, trying your personal key instead:', err.message);
  }
  // 2) Fallback: original behavior, using a personal key from this browser
  await importPlaylistWithPersonalKey(playlistId);
}

async function importPlaylistWithPersonalKey(playlistId) {
  const apiKey = localStorage.getItem('syncroom_yt_key');
  if (!apiKey) {
    alert('Add a YouTube Data API v3 key on the join screen to import playlists (reload to enter one).');
    return;
  }
  try {
    let items = [];
    let pageToken = '';
    do {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&pageToken=${pageToken}&key=${apiKey}`
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      items = items.concat(
        (data.items || [])
          .filter(it => it.snippet?.resourceId?.videoId)
          .map(it => ({ videoId: it.snippet.resourceId.videoId, title: it.snippet.title }))
      );
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    if (items.length === 0) {
      alert('No videos found in that playlist (it may be private).');
      return;
    }
    socket.emit('queue:add-many', { items });
  } catch (err) {
    alert('Playlist import failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Search — shared server key first, falls back to a personal key if a
// visitor has added one and the server has none configured.
// ---------------------------------------------------------------------------
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  searchResultsEl.innerHTML = '<div class="muted small">Searching…</div>';
  try {
    const items = await searchYouTube(q);
    renderSearchResults(items);
  } catch (err) {
    searchResultsEl.innerHTML = `<div class="muted small">Search failed: ${escapeHtml(err.message)}</div>`;
  }
});

async function searchYouTube(query) {
  const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(query)}`);
  if (res.status !== 501) {
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.items || [];
  }
  // Server has no shared key — fall back to a personal key if present
  const apiKey = localStorage.getItem('syncroom_yt_key');
  if (!apiKey) throw new Error('No API key available yet (server or personal) — add one on the join screen.');
  const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q=${encodeURIComponent(query)}&key=${apiKey}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return (data.items || []).map(it => ({
    videoId: it.id.videoId,
    title: it.snippet.title,
    channelTitle: it.snippet.channelTitle,
    thumbnail: it.snippet.thumbnails?.default?.url || ''
  }));
}

function renderSearchResults(items) {
  if (!items || items.length === 0) {
    searchResultsEl.innerHTML = '<div class="muted small">No results.</div>';
    return;
  }
  searchResultsEl.innerHTML = '';
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'search-result-item';
    row.innerHTML = `
      <img src="${item.thumbnail}" alt="">
      <div class="sr-info">
        <div class="sr-title">${escapeHtml(item.title)}</div>
        <div class="sr-channel muted small">${escapeHtml(item.channelTitle || '')}</div>
      </div>
      <button type="button" class="ghost-btn sr-add">+ Add</button>
    `;
    row.querySelector('.sr-add').addEventListener('click', () => {
      socket.emit('queue:add', { videoId: item.videoId, title: item.title });
    });
    searchResultsEl.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat:message', { text });
  chatInput.value = '';
});

socket.on('chat:message', ({ name, text, id }) => {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="who">${escapeHtml(name)}${id === myId ? ' (you)' : ''}:</span> ${escapeHtml(text)}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

// ---------------------------------------------------------------------------
// Orbit avatars around the vinyl (purely decorative, reflects who's in room)
// ---------------------------------------------------------------------------
function renderOrbit() {
  const ids = Array.from(membersById.keys());
  const n = Math.max(ids.length, 1);
  const cx = 160, cy = 160, r = 150;
  let svg = '';
  ids.forEach((id, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    const m = membersById.get(id);
    const color = m?.mic ? 'var(--accent-2)' : 'var(--line)';
    svg += `<circle cx="${x}" cy="${y}" r="6" fill="${color}"/>`;
  });
  dialOrbit.innerHTML = svg;
}
setInterval(renderOrbit, 1000);
