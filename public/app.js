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
let currentHostId = null;
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

// When the server tells us to start playing (a fresh play, a seek-while-
// playing, or a new track), we estimate the correct position using network
// latency alone. But YouTube then has to buffer before playback truly
// begins, and that buffering time varies per client/network — so the
// position is stale by the time the video actually starts. We stash the
// server's original {position, updatedAt} here and, once the player
// actually reaches the PLAYING state, correct against real elapsed time.
let pendingSync = null;

// Unlike pendingSync (which only exists briefly during a play/seek/load
// transition), lastKnownSync is the ongoing "source of truth" timeline
// while a track is simply playing. Small clock/decoder differences between
// devices accumulate minute to minute even when nothing else happens, so we
// keep this around to periodically re-check against, not just at transitions.
let lastKnownSync = null; // { position, updatedAt } or null while paused

let localStream = null;
const peers = new Map(); // socketId -> { pc, name, tile, stream }
const DRIFT_TOLERANCE = 0.6; // seconds of drift before we nudge playback rate
const HARD_RESEEK_TOLERANCE = 1.5; // seconds of drift before we force a jump-cut seek

// ---------------------------------------------------------------------------
// Clock sync
// ---------------------------------------------------------------------------
// All sync math below is "server said position P at server-time T; how far
// past T are we now?" That only works if every client's Date.now() agrees
// with the server's. In reality every device's clock is off by anywhere
// from a few hundred ms to several seconds — and unlike network jitter,
// that error never corrects itself, so it shows up as a constant lag
// between people (exactly the "slight delay" symptom). clockOffset is our
// best estimate of (server time) - (our Date.now()); now() below applies it
// everywhere elapsed time is computed against a server timestamp.
let clockOffset = 0;
function now() {
  return Date.now() + clockOffset;
}
function syncClock() {
  const clientSentAt = Date.now();
  socket.emit('time:sync', clientSentAt);
}
socket.on('time:sync', ({ clientSentAt, serverTime }) => {
  const rtt = Date.now() - clientSentAt;
  // Assume the request and response each took half the round trip; the
  // server's clock, adjusted for that one-way delay, is our best estimate
  // of "true now" at the moment we received this reply.
  const estimatedServerNowAtReceipt = serverTime + rtt / 2;
  clockOffset = estimatedServerNowAtReceipt - Date.now();
});
socket.on('connect', syncClock);
setInterval(syncClock, 15000);
// Background tabs throttle timers, so drift can build up silently while a
// tab is hidden. Re-sync the instant the tab is foregrounded again instead
// of waiting for the next 15s tick.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncClock();
});

// ICE servers: STUN alone only helps peers find their public IP — it does
// nothing when a direct connection genuinely can't be made (symmetric NAT,
// mobile data, strict office/campus WiFi). A TURN server relays media in
// those cases. We start with STUN-only so nothing breaks if no TURN is
// configured, then upgrade to real TURN credentials if the server has them
// (see /api/turn-credentials below) — this is very likely why calls worked
// during local testing but fail for real people joining from other networks.
let RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};
(async () => {
  try {
    const res = await fetch('/api/turn-credentials');
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      RTC_CONFIG = { iceServers: data.iceServers };
      console.log('TURN-capable ICE config loaded.');
    }
  } catch (err) {
    console.warn('Falling back to STUN-only ICE config:', err.message);
  }
})();

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
const selfPreview = document.getElementById('self-preview');
const selfPreviewVideo = document.getElementById('self-preview-video');
const videoSizeSlider = document.getElementById('video-size-slider');
const leaveBtn = document.getElementById('leave-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');

const vinyl = document.getElementById('vinyl');
const dialOrbit = document.getElementById('dial-orbit');
const nowPlayingTitle = document.getElementById('now-playing-title');
const prevBtn = document.getElementById('prev-btn');
const skipBackBtn = document.getElementById('skip-back-btn');
const playPauseBtn = document.getElementById('play-pause-btn');
const skipForwardBtn = document.getElementById('skip-forward-btn');
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
  if (!on) {
    if (!localStream || localStream.getAudioTracks().length === 0) await initLocalMedia();
    if (localStream.getAudioTracks().length === 0) {
      alert('Microphone access was blocked or denied. Click the padlock/site-info icon in your address bar, allow microphone access, then try again.');
      return;
    }
  }
  localStream.getAudioTracks().forEach(t => (t.enabled = !on));
  micBtn.setAttribute('data-on', String(!on));
  socket.emit('presence:update', { mic: !on });
  renderMyTile();
});

camBtn.addEventListener('click', async () => {
  const on = camBtn.getAttribute('data-on') === 'true';
  if (!on) {
    // getUserMedia is only available in a "secure context" — https://, or
    // http://localhost during local dev. Deployed over plain http://, the
    // call silently isn't there at all (not even a permission prompt), which
    // looks identical to "camera isn't working" from the user's side.
    if (!navigator.mediaDevices || !window.isSecureContext) {
      alert('Camera access requires HTTPS. This page must be loaded over https:// (or localhost) for the camera to work.');
      return;
    }
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = camStream.getVideoTracks()[0];
      localStream.addTrack(track);
      peers.forEach(({ pc }) => pc.addTrack(track, localStream));
      selfPreviewVideo.srcObject = new MediaStream([track]);
      selfPreview.classList.remove('hidden');
    } catch (err) {
      const hint = err.name === 'NotAllowedError'
        ? 'Camera permission was blocked. Click the padlock/site-info icon in your address bar, allow camera access, then try again.'
        : err.message;
      alert('Could not access camera: ' + hint);
      return;
    }
  } else {
    localStream.getVideoTracks().forEach(t => {
      t.stop();
      localStream.removeTrack(t);
    });
    selfPreviewVideo.srcObject = null;
    selfPreview.classList.add('hidden');
  }
  camBtn.setAttribute('data-on', String(!on));
  socket.emit('presence:update', { cam: !on });
  renderMyTile();
});

// ---------------------------------------------------------------------------
// Resizable video previews — one slider drives both the self-preview and
// every participant tile via CSS variables, so "resize" works identically
// with mouse drag on desktop and touch drag on mobile (native range inputs
// already handle both), no custom pointer-tracking code needed.
// ---------------------------------------------------------------------------
function applyVideoSize(tileSize) {
  const root = document.documentElement.style;
  root.setProperty('--tile-size', `${tileSize}px`);
  root.setProperty('--self-preview-w', `${tileSize * 2.9}px`);
}
const savedVideoSize = parseInt(localStorage.getItem('syncroom_video_size'), 10);
const initialVideoSize = Number.isFinite(savedVideoSize) ? savedVideoSize : Number(videoSizeSlider.value);
videoSizeSlider.value = initialVideoSize;
applyVideoSize(initialVideoSize);
videoSizeSlider.addEventListener('input', () => {
  applyVideoSize(videoSizeSlider.value);
  localStorage.setItem('syncroom_video_size', videoSizeSlider.value);
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
  currentHostId = state.hostId;
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

// Kept up to date so exactly one client (the host) drives auto-advance
// when a track ends — see onPlayerStateChange. Without a single owner,
// every client in the room would each call queue:next on the same ended
// track and the queue would skip ahead by one track per listener.
socket.on('host:update', ({ hostId }) => {
  currentHostId = hostId;
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
  const videoTrack = localStream?.getVideoTracks()[0];
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `tile-${myId}`;
    tile.className = 'tile';
    tilesEl.prepend(tile);
  }
  tile.classList.toggle('speaking', mic);
  tile.innerHTML = `
    ${videoTrack ? '<video autoplay playsinline muted></video>' : `<div class="avatar">${initials(myName)}</div>`}
    <div class="who">
      <span class="name">${escapeHtml(myName)} (you)</span>
      <span class="status">${mic ? '🎙️ live' : 'muted'}${cam ? ' · cam on' : ''}</span>
    </div>`;
  if (videoTrack) {
    // Muted, since this is our own camera — we don't want to hear our own echo.
    tile.querySelector('video').srcObject = new MediaStream([videoTrack]);
  }
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
  const audioTrack = entry?.stream.getAudioTracks()[0];
  tile.innerHTML = `
    ${videoTrack ? '<video autoplay playsinline></video>' : `<div class="avatar">${initials(name)}</div>`}
    <audio autoplay></audio>
    <div class="who">
      <span class="name">${escapeHtml(name)}</span>
      <span class="status">${m?.mic ? '🎙️ live' : 'muted'}${m?.cam ? ' · cam on' : ''}</span>
    </div>`;
  if (videoTrack) {
    const videoEl = tile.querySelector('video');
    videoEl.srcObject = new MediaStream([videoTrack]);
  }
  // The peer's audio track arrives over WebRTC the same way video does, but
  // it needs its own playable element — a <video> element with no matching
  // <audio> silently drops the audio track entirely, which is why mic input
  // was never actually heard even though it reached the browser fine.
  if (audioTrack) {
    tile.querySelector('audio').srcObject = new MediaStream([audioTrack]);
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
  const elapsed = playing ? (now() - updatedAt) / 1000 : 0;
  const startAt = Math.max(0, position + elapsed);
  ytPlayer.loadVideoById({ videoId, startSeconds: startAt });
  if (audioUnlocked && playing) ytPlayer.unMute();
  if (!playing) setTimeout(() => ytPlayer.pauseVideo(), 400);
  vinyl.classList.toggle('spinning', playing);
  nowPlayingTitle.textContent = (queue[currentIndex] && queue[currentIndex].title) || videoId;
  updatePlayPauseIcon(playing);
  updateMediaSessionMetadata();

  // startAt was only an estimate (server position + elapsed network time).
  // Loading/buffering the new video takes additional real time that varies
  // per client, so once it's actually playing we correct against the true
  // elapsed time since the server's timestamp, not just our upfront guess.
  pendingSync = playing ? { position, updatedAt } : null;
  lastKnownSync = playing ? { position, updatedAt } : null;
}

function onPlayerStateChange(e) {
  // We drive sync via socket events, not by re-broadcasting every native
  // player event, to avoid feedback loops between clients.

  // This is the fix for the "few seconds apart" desync: YouTube reports
  // PLAYING only once it has actually started rendering frames — i.e.
  // buffering is over. That's the one moment we can trust "now" as the
  // true start time, so we recompute where we *should* be (using the
  // original server timestamp) and correct any drift right then.
  if (e.data === YT.PlayerState.PLAYING && pendingSync) {
    const { position, updatedAt } = pendingSync;
    const trueElapsed = (now() - updatedAt) / 1000;
    const target = Math.max(0, position + trueElapsed);
    reconcilePosition(target);
    pendingSync = null;
  }

  // Auto-advance when the track finishes. Only the host emits queue:next
  // here — every client in the room gets an ENDED event for the same
  // track at roughly the same moment, so without a single owner they'd
  // each request the next track and the queue would jump ahead multiple
  // songs instead of one.
  if (e.data === YT.PlayerState.ENDED && myId && myId === currentHostId) {
    socket.emit('queue:next');
  }
}

// Reconcile our actual playback position against where we should be.
// Small gaps (a fraction of a second, typical of normal network jitter) are
// corrected by briefly nudging playbackRate instead of seeking — seekTo()
// causes a visible/audible jump-cut, while a rate nudge closes the gap
// smoothly over a couple of seconds, which is what actually reads as "in
// sync" to a listener. Only a large gap (a real stall, tab was backgrounded,
// etc.) gets a hard seek, since nudging would take too long to matter.
let rateNudgeTimeout = null;
function reconcilePosition(target) {
  if (!ytPlayer || !ytPlayer.getCurrentTime) return;
  const actual = ytPlayer.getCurrentTime();
  const diff = target - actual;
  const absDiff = Math.abs(diff);
  if (absDiff > HARD_RESEEK_TOLERANCE) {
    ytPlayer.seekTo(target, true);
    ytPlayer.setPlaybackRate(1);
  } else if (absDiff > DRIFT_TOLERANCE) {
    ytPlayer.setPlaybackRate(diff > 0 ? 1.1 : 0.9);
    clearTimeout(rateNudgeTimeout);
    rateNudgeTimeout = setTimeout(() => ytPlayer.setPlaybackRate(1), 2000);
  }
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
// Named functions (not just inline listeners) so the Media Session handlers
// below — which power lock-screen / notification controls for background
// playback — can trigger the exact same logic as tapping the on-screen buttons.
function togglePlayPause() {
  if (!ytPlayer || currentIndex === -1) return;
  const pos = ytPlayer.getCurrentTime();
  // Act locally, synchronously, inside the click — don't wait on the
  // socket round trip, or the browser no longer counts this as a
  // user-gesture-triggered play and may block audio.
  pendingSync = null; // this client is acting locally/synchronously, no estimate to correct
  if (isPlayingState) {
    isPlayingState = false;
    lastKnownSync = null;
    ytPlayer.pauseVideo();
    vinyl.classList.remove('spinning');
    updatePlayPauseIcon(false);
    socket.emit('music:pause', { position: pos });
  } else {
    isPlayingState = true;
    lastKnownSync = { position: pos, updatedAt: Date.now() };
    ytPlayer.unMute();
    ytPlayer.playVideo();
    vinyl.classList.add('spinning');
    updatePlayPauseIcon(true);
    socket.emit('music:play', { position: pos });
  }
}
function goToPrevTrack() { socket.emit('queue:prev'); }
function goToNextTrack() { socket.emit('queue:next'); }

// ±10s skip: act locally/synchronously first (same user-gesture-audio
// reasoning as play/pause above), then broadcast the resulting position.
function skipBack10() {
  if (!ytPlayer || currentIndex === -1) return;
  const target = Math.max(0, ytPlayer.getCurrentTime() - 10);
  ytPlayer.seekTo(target, true);
  socket.emit('music:seek', { position: target });
}
function skipForward10() {
  if (!ytPlayer || currentIndex === -1) return;
  const duration = ytPlayer.getDuration() || Infinity;
  const target = Math.min(duration, ytPlayer.getCurrentTime() + 10);
  ytPlayer.seekTo(target, true);
  socket.emit('music:seek', { position: target });
}

playPauseBtn.addEventListener('click', togglePlayPause);
prevBtn.addEventListener('click', goToPrevTrack);
nextBtn.addEventListener('click', goToNextTrack);
skipBackBtn.addEventListener('click', skipBack10);
skipForwardBtn.addEventListener('click', skipForward10);

// --- Media Session: lock-screen / notification-shade controls, and the
// signal mobile browsers use to decide "this tab has an active media
// player, don't suspend its audio when backgrounded". Without this, the
// browser has no way of knowing the 1x1 hidden YouTube iframe is actually
// a music player the user cares about.
function updateMediaSessionMetadata() {
  if (!('mediaSession' in navigator)) return;
  const track = queue[currentIndex];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: (track && track.title) || 'Nothing queued yet',
    artist: roomId ? `SyncRoom · ${roomId}` : 'SyncRoom',
  });
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', togglePlayPause);
  navigator.mediaSession.setActionHandler('pause', togglePlayPause);
  navigator.mediaSession.setActionHandler('previoustrack', goToPrevTrack);
  navigator.mediaSession.setActionHandler('nexttrack', goToNextTrack);
  navigator.mediaSession.setActionHandler('seekbackward', skipBack10);
  navigator.mediaSession.setActionHandler('seekforward', skipForward10);
  // Some Android/desktop UIs expose a scrubber on the lock screen / notification
  // itself rather than fixed ±10s buttons — support that too when offered.
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (!ytPlayer || details.seekTime == null) return;
    ytPlayer.seekTo(details.seekTime, true);
    socket.emit('music:seek', { position: details.seekTime });
  });
}

seekBar.addEventListener('change', () => {
  if (!ytPlayer) return;
  const duration = ytPlayer.getDuration() || 0;
  const pos = (seekBar.value / 100) * duration;
  ytPlayer.seekTo(pos, true);
  socket.emit('music:seek', { position: pos });
});

socket.on('music:play', ({ position, updatedAt }) => {
  isPlayingState = true;
  if (ytPlayer) {
    ytPlayer.seekTo(position + (now() - updatedAt) / 1000, true);
    if (audioUnlocked) ytPlayer.unMute();
    ytPlayer.playVideo();
    // The seekTo above is just our best upfront guess. Buffering after
    // play/seek takes an unpredictable amount of real time, so remember
    // the server's original timestamp and correct once PLAYING actually
    // fires (see onPlayerStateChange).
    pendingSync = { position, updatedAt };
    lastKnownSync = { position, updatedAt };
  }
  vinyl.classList.add('spinning');
  updatePlayPauseIcon(true);
});

socket.on('music:pause', ({ position }) => {
  isPlayingState = false;
  pendingSync = null; // a pause cancels any correction that was waiting on PLAYING
  lastKnownSync = null; // a pause cancels any correction that was waiting on PLAYING
  if (ytPlayer) {
    ytPlayer.seekTo(position, true);
    ytPlayer.pauseVideo();
  }
  vinyl.classList.remove('spinning');
  updatePlayPauseIcon(false);
});

socket.on('music:seek', ({ position, updatedAt }) => {
  if (!ytPlayer) return;
  const target = position + (isPlayingState ? (now() - updatedAt) / 1000 : 0);
  ytPlayer.seekTo(target, true);
  // Seeking while playing re-triggers buffering too, so the same
  // buffer-then-correct handling applies here.
  pendingSync = isPlayingState ? { position, updatedAt } : null;
  lastKnownSync = isPlayingState ? { position, updatedAt } : null;
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
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
}

// Periodic drift correction + progress bar update
// Progress bar update (every 500ms) + real periodic drift correction
// (every ~8s) so small per-device timing differences don't quietly grow
// over the course of a track — not just at play/pause/seek/load moments.
let driftCheckCounter = 0;
setInterval(() => {
  if (!ytPlayer || !ytPlayer.getCurrentTime || currentIndex === -1) return;
  const duration = ytPlayer.getDuration() || 0;
  const current = ytPlayer.getCurrentTime() || 0;
  if (duration > 0) {
    seekBar.value = Math.min(100, (current / duration) * 100);
    timeCurrent.textContent = formatTime(current);
    timeDuration.textContent = formatTime(duration);
  }

  driftCheckCounter++;
  if (driftCheckCounter < 8) return; // ~4s at 500ms/tick — tighter than before (was ~8s)
  driftCheckCounter = 0;

  if (pendingSync || !isPlayingState || !lastKnownSync) return;
  if (ytPlayer.getPlayerState && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) return;

  const target = lastKnownSync.position + (now() - lastKnownSync.updatedAt) / 1000;
  reconcilePosition(target);
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
    li.innerHTML = `
      <span class="qi">${i + 1}</span>
      <span class="qt">${escapeHtml(item.title || item.videoId)}</span>
      <span class="q-controls">
        <button type="button" class="q-btn q-up" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="q-btn q-down" title="Move down" ${i === queue.length - 1 ? 'disabled' : ''}>▼</button>
        <button type="button" class="q-btn q-remove" title="Remove from queue">✕</button>
      </span>`;
    // Clicking the title/number loads that track; the control buttons stop
    // propagation so they don't also trigger a load.
    li.querySelector('.qt').addEventListener('click', () => socket.emit('music:load-index', { index: i }));
    li.querySelector('.qi').addEventListener('click', () => socket.emit('music:load-index', { index: i }));
    li.querySelector('.q-up').addEventListener('click', (e) => {
      e.stopPropagation();
      if (i > 0) socket.emit('queue:move', { from: i, to: i - 1 });
    });
    li.querySelector('.q-down').addEventListener('click', (e) => {
      e.stopPropagation();
      if (i < queue.length - 1) socket.emit('queue:move', { from: i, to: i + 1 });
    });
    li.querySelector('.q-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('queue:remove', { index: i });
    });
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

  const closeRow = document.createElement('div');
  closeRow.className = 'search-results-close-row';
  closeRow.innerHTML = `<button type="button" class="ghost-btn sr-close">Close results</button>`;
  closeRow.querySelector('.sr-close').addEventListener('click', clearSearch);
  searchResultsEl.appendChild(closeRow);

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
      // Once a track's been picked, the search UI has done its job —
      // clear it out instead of leaving stale results sitting there
      // permanently with no way to get rid of them.
      clearSearch();
    });
    searchResultsEl.appendChild(row);
  });
}

function clearSearch() {
  searchResultsEl.innerHTML = '';
  searchInput.value = '';
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