// SyncRoom server
require('dotenv').config();

// Responsibilities:
//   1. Track lightweight room state (queue, current track, play/pause position)
//   2. Relay music sync events to everyone in a room (never touches audio)
//   3. Relay WebRTC signaling (offer/answer/ice) so peers can set up their own
//      audio/video connections directly with each other (mesh topology)
//   4. Relay chat messages
//
// Nothing here ever proxies YouTube audio or call audio/video -- that all
// flows client-to-client (WebRTC) or client-to-YouTube (IFrame player), so
// quality is never bottlenecked by this server.

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // tighten this to your real origin in production
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Google Sign-In (OAuth 2.0) — lets a user log in with their own Google
// account so their home feed can be built from their real subscriptions and
// liked videos, instead of generic search results. Uses no extra npm
// packages: sessions are a random token in an httpOnly cookie, mapped to
// tokens/profile in memory (server restart = everyone logged out, which is
// fine for this app's scale). Nothing here proxies video/audio — this only
// ever calls YouTube's metadata endpoints (subscriptions, playlists).
// ---------------------------------------------------------------------------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Must match an "Authorized redirect URI" registered in Google Cloud exactly.
// Set GOOGLE_REDIRECT_URI in .env for your deployed domain; falls back to
// localhost for local dev.
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;

const sessions = new Map(); // sessionId -> { accessToken, refreshToken, expiresAt, profile }
const pendingStates = new Map(); // oauth `state` -> expiry timestamp (CSRF protection)

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.syncroom_sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}

app.use((req, res, next) => {
  req.syncroomSession = getSession(req);
  next();
});

app.get('/auth/google/status', (req, res) => {
  res.json({ configured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) });
});

app.get('/auth/google/login', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(501).send('Google sign-in is not configured on this server yet.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 5 * 60 * 1000); // 5 min to complete login
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline', // request a refresh_token
    prompt: 'consent',      // ensure refresh_token is issued even on repeat logins
    scope: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' '),
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?auth=error');
  const stateExpiry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!code || !stateExpiry || stateExpiry < Date.now()) {
    return res.redirect('/?auth=error');
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileRes.json();

    const sessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(sessionId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      profile: { name: profile.name, avatar: profile.picture, email: profile.email }
    });

    const isHttps = GOOGLE_REDIRECT_URI.startsWith('https');
    res.setHeader('Set-Cookie',
      `syncroom_sid=${sessionId}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${isHttps ? '; Secure' : ''}`
    );
    res.redirect('/');
  } catch (err) {
    console.error('Google OAuth callback failed:', err.message);
    res.redirect('/?auth=error');
  }
});

app.post('/auth/google/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.syncroom_sid) sessions.delete(cookies.syncroom_sid);
  res.setHeader('Set-Cookie', 'syncroom_sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = req.syncroomSession;
  if (!session) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: session.profile.name, avatar: session.profile.avatar });
});

// Refreshes the access token in-place if it's expired (or about to be),
// using the stored refresh_token. Returns a usable access token, or null if
// the session can't be refreshed (rare — usually means they revoked access).
async function getValidAccessToken(session) {
  if (session.expiresAt > Date.now() + 30000) return session.accessToken;
  if (!session.refreshToken) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: session.refreshToken,
        grant_type: 'refresh_token'
      })
    });
    const data = await r.json();
    if (data.error) return null;
    session.accessToken = data.access_token;
    session.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return session.accessToken;
  } catch {
    return null;
  }
}

function requireLogin(req, res, next) {
  if (!req.syncroomSession) return res.status(401).json({ error: 'not_logged_in' });
  next();
}

// Builds a "recent uploads from channels you're subscribed to" feed.
// Quota-efficient path: subscriptions.list (1 unit) -> channels.list batched
// in groups of 50 to get each channel's uploads-playlist id (1 unit per
// batch) -> playlistItems.list per channel for recent items (1 unit each).
// This avoids search.list, which costs 100 units per call.
app.get('/api/youtube/subscriptions', requireLogin, async (req, res) => {
  const token = await getValidAccessToken(req.syncroomSession);
  if (!token) return res.status(401).json({ error: 'reauth_required' });
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const subRes = await fetch(
      'https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50&order=alphabetical',
      { headers: auth }
    );
    const subData = await subRes.json();
    if (subData.error) return res.status(502).json({ error: subData.error.message });
    const channelIds = (subData.items || []).map(it => it.snippet.resourceId.channelId).slice(0, 20);
    if (channelIds.length === 0) return res.json({ items: [] });

    const chanRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelIds.join(',')}`,
      { headers: auth }
    );
    const chanData = await chanRes.json();
    if (chanData.error) return res.status(502).json({ error: chanData.error.message });
    const uploadPlaylistIds = (chanData.items || [])
      .map(c => c.contentDetails?.relatedPlaylists?.uploads)
      .filter(Boolean);

    const perChannel = await Promise.all(uploadPlaylistIds.map(async (playlistId) => {
      try {
        const r = await fetch(
          `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=5&playlistId=${playlistId}`,
          { headers: auth }
        );
        const d = await r.json();
        if (d.error) return [];
        return (d.items || []).map(it => ({
          videoId: it.snippet.resourceId?.videoId,
          title: it.snippet.title,
          channelTitle: it.snippet.videoOwnerChannelTitle || it.snippet.channelTitle,
          thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || '',
          publishedAt: it.snippet.publishedAt
        })).filter(v => v.videoId);
      } catch {
        return [];
      }
    }));

    const items = perChannel.flat()
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 24);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liked videos — pulled from the special "Liked videos" playlist on the
// user's own channel (its ID varies per account, so we look it up first).
app.get('/api/youtube/liked', requireLogin, async (req, res) => {
  const token = await getValidAccessToken(req.syncroomSession);
  if (!token) return res.status(401).json({ error: 'reauth_required' });
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const meRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true',
      { headers: auth }
    );
    const meData = await meRes.json();
    if (meData.error) return res.status(502).json({ error: meData.error.message });
    const likesPlaylistId = meData.items?.[0]?.contentDetails?.relatedPlaylists?.likes;
    if (!likesPlaylistId) return res.json({ items: [] });

    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=24&playlistId=${likesPlaylistId}`,
      { headers: auth }
    );
    const d = await r.json();
    if (d.error) return res.status(502).json({ error: d.error.message });
    const items = (d.items || []).map(it => ({
      videoId: it.snippet.resourceId?.videoId,
      title: it.snippet.title,
      channelTitle: it.snippet.videoOwnerChannelTitle || it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || ''
    })).filter(v => v.videoId);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// YouTube Data API proxy — uses ONE server-held key (env var YOUTUBE_API_KEY)
// so visitors never have to paste in their own key. If no server key is set,
// these return 501 and the client falls back to a personal key (unchanged
// original behavior), so nothing breaks for people who already added one.
// ---------------------------------------------------------------------------
app.get('/api/youtube/config', (req, res) => {
  res.json({ hasServerKey: Boolean(process.env.YOUTUBE_API_KEY) });
});

// ---------------------------------------------------------------------------
// TURN credentials — needed for calls to work once real people join from
// different networks (STUN alone often can't punch through mobile/corporate
// NATs). Uses a free Metered/Open Relay account if configured via env vars
// METERED_APP_NAME + METERED_API_KEY; otherwise safely falls back to
// STUN-only (today's behavior), so this never breaks anything on its own.
// ---------------------------------------------------------------------------
app.get('/api/turn-credentials', async (req, res) => {
  const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const apiKey = process.env.METERED_API_KEY;
  const appName = process.env.METERED_APP_NAME;
  if (!apiKey || !appName) return res.json(fallback);
  try {
    const r = await fetch(`https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
    const iceServers = await r.json();
    if (!Array.isArray(iceServers) || iceServers.length === 0) return res.json(fallback);
    res.json({ iceServers });
  } catch (err) {
    res.json(fallback);
  }
});

app.get('/api/youtube/search', async (req, res) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(501).json({ error: 'no_server_key' });
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'missing_query' });
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q=${encodeURIComponent(q)}&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    const items = (data.items || []).map(it => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channelTitle: it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || ''
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/youtube/playlist', async (req, res) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(501).json({ error: 'no_server_key' });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'missing_id' });
  try {
    let items = [];
    let pageToken = '';
    do {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(id)}&pageToken=${pageToken}&key=${apiKey}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.error) return res.status(502).json({ error: data.error.message });
      items = items.concat(
        (data.items || [])
          .filter(it => it.snippet?.resourceId?.videoId)
          .map(it => ({ videoId: it.snippet.resourceId.videoId, title: it.snippet.title }))
      );
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * rooms: Map<roomId, {
 *   queue: [{ videoId, title }],
 *   currentIndex: number,
 *   isPlaying: boolean,
 *   position: number,       // seconds, as of `updatedAt`
 *   updatedAt: number,      // server timestamp (ms) when position was last true
 *   hostId: string,         // socket.id with playback control (first to join)
 *   members: Map<socketId, { name, mic: boolean, cam: boolean }>
 * }>
 */
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      queue: [],
      currentIndex: -1,
      isPlaying: false,
      position: 0,
      updatedAt: Date.now(),
      hostId: null,
      members: new Map()
    });
  }
  return rooms.get(roomId);
}

function roomSnapshot(room) {
  return {
    queue: room.queue,
    currentIndex: room.currentIndex,
    isPlaying: room.isPlaying,
    position: room.position,
    updatedAt: room.updatedAt,
    hostId: room.hostId,
    members: Array.from(room.members.entries()).map(([id, m]) => ({ id, ...m }))
  };
}

function cleanupEmptyRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.members.size === 0) rooms.delete(roomId);
}

io.on('connection', (socket) => {
  let currentRoomId = null;

  // ---- Clock sync ----
  // Every sync calculation below (music:play/pause/seek/load-index) trusts
  // that "Date.now() on the server" and "Date.now() on each client" mean the
  // same instant. In practice every device's clock is off by anywhere from a
  // few hundred ms to a few seconds, and that error shows up as a constant,
  // never-correcting lag between people. This just echoes back the client's
  // own send-time plus the server's time, so the client can measure round-
  // trip time and compute its personal offset from server time (see
  // syncClock() in app.js). No room/game state involved — just a timestamp.
  socket.on('time:sync', (clientSentAt) => {
    socket.emit('time:sync', { clientSentAt, serverTime: Date.now() });
  });

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId) return;
    currentRoomId = roomId;
    const room = getOrCreateRoom(roomId);

    // First person in becomes host (controls playback authority on ties)
    if (room.members.size === 0) room.hostId = socket.id;

    room.members.set(socket.id, { name: name || 'Guest', mic: false, cam: false });
    socket.join(roomId);

    // Tell the newcomer the current state + who's already here (for WebRTC mesh setup)
    socket.emit('room-state', roomSnapshot(room));

    // Tell everyone else someone joined (so existing peers can initiate WebRTC offers)
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: name || 'Guest' });
  });

  // ---- Music sync events ----
  // Client sends the action + the position at the moment of the action.
  // Server stamps its own time so all clients can compute "true now" position
  // as: isPlaying ? position + (now - updatedAt) / 1000 : position

  socket.on('music:play', ({ position }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.isPlaying = true;
    room.position = position;
    room.updatedAt = Date.now();
    // socket.to (not io.to): the sender already applied this play locally
    // and synchronously inside their own click handler. Echoing it back
    // to them too just re-triggers a second, latency-skewed seek/play on
    // their own player a moment later, causing a visible stutter.
    socket.to(currentRoomId).emit('music:play', { position, updatedAt: room.updatedAt });
  });

  socket.on('music:pause', ({ position }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.isPlaying = false;
    room.position = position;
    room.updatedAt = Date.now();
    socket.to(currentRoomId).emit('music:pause', { position, updatedAt: room.updatedAt });
  });

  socket.on('music:seek', ({ position }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.position = position;
    room.updatedAt = Date.now();
    // Same reasoning: every client that emits music:seek (skip ±10s, seek
    // bar drag) now performs the seek locally first (see app.js), so this
    // broadcast only needs to reach everyone else.
    socket.to(currentRoomId).emit('music:seek', { position, updatedAt: room.updatedAt });
  });

  socket.on('music:load-index', ({ index }) => {
    const room = rooms.get(currentRoomId);
    if (!room || !room.queue[index]) return;
    room.currentIndex = index;
    room.isPlaying = true;
    room.position = 0;
    room.updatedAt = Date.now();
    io.to(currentRoomId).emit('music:load-index', {
      index, videoId: room.queue[index].videoId, updatedAt: room.updatedAt
    });
  });

  socket.on('queue:add', ({ videoId, title }) => {
    const room = rooms.get(currentRoomId);
    if (!room || !videoId) return;
    room.queue.push({ videoId, title: title || videoId });
    if (room.currentIndex === -1) room.currentIndex = 0;
    io.to(currentRoomId).emit('queue:update', { queue: room.queue, currentIndex: room.currentIndex });
  });

  socket.on('queue:add-many', ({ items }) => {
    const room = rooms.get(currentRoomId);
    if (!room || !Array.isArray(items)) return;
    room.queue.push(...items.filter(i => i && i.videoId));
    if (room.currentIndex === -1 && room.queue.length > 0) room.currentIndex = 0;
    io.to(currentRoomId).emit('queue:update', { queue: room.queue, currentIndex: room.currentIndex });
  });

  socket.on('queue:next', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.queue.length === 0) return;
    room.currentIndex = (room.currentIndex + 1) % room.queue.length;
    room.isPlaying = true;
    room.position = 0;
    room.updatedAt = Date.now();
    io.to(currentRoomId).emit('music:load-index', {
      index: room.currentIndex, videoId: room.queue[room.currentIndex].videoId, updatedAt: room.updatedAt
    });
  });

  socket.on('queue:prev', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.queue.length === 0) return;
    room.currentIndex = (room.currentIndex - 1 + room.queue.length) % room.queue.length;
    room.isPlaying = true;
    room.position = 0;
    room.updatedAt = Date.now();
    io.to(currentRoomId).emit('music:load-index', {
      index: room.currentIndex, videoId: room.queue[room.currentIndex].videoId, updatedAt: room.updatedAt
    });
  });

  socket.on('queue:remove', ({ index }) => {
    const room = rooms.get(currentRoomId);
    if (!room || index < 0 || index >= room.queue.length) return;

    const removingCurrent = index === room.currentIndex;
    room.queue.splice(index, 1);

    if (room.queue.length === 0) {
      room.currentIndex = -1;
      room.isPlaying = false;
      room.position = 0;
      room.updatedAt = Date.now();
    } else if (removingCurrent) {
      // Keep the same slot (the next track slides into it); if we removed
      // the last item, wrap to 0 instead of pointing past the end.
      room.currentIndex = Math.min(index, room.queue.length - 1);
      room.isPlaying = true;
      room.position = 0;
      room.updatedAt = Date.now();
    } else if (index < room.currentIndex) {
      // Everything after the removed slot shifted down by one.
      room.currentIndex -= 1;
    }

    io.to(currentRoomId).emit('queue:update', { queue: room.queue, currentIndex: room.currentIndex });
    if (removingCurrent && room.queue.length > 0) {
      io.to(currentRoomId).emit('music:load-index', {
        index: room.currentIndex, videoId: room.queue[room.currentIndex].videoId, updatedAt: room.updatedAt
      });
    }
  });

  socket.on('queue:move', ({ from, to }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const len = room.queue.length;
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) return;

    const wasCurrent = room.currentIndex;
    const [item] = room.queue.splice(from, 1);
    room.queue.splice(to, 0, item);

    // Keep currentIndex pointing at the same *track*, not the same slot.
    if (wasCurrent === from) {
      room.currentIndex = to;
    } else if (from < wasCurrent && to >= wasCurrent) {
      room.currentIndex -= 1;
    } else if (from > wasCurrent && to <= wasCurrent) {
      room.currentIndex += 1;
    }

    io.to(currentRoomId).emit('queue:update', { queue: room.queue, currentIndex: room.currentIndex });
  });

  // ---- Chat ----
  socket.on('chat:message', ({ text }) => {
    const room = rooms.get(currentRoomId);
    if (!room || !text) return;
    const member = room.members.get(socket.id);
    io.to(currentRoomId).emit('chat:message', {
      id: socket.id,
      name: member ? member.name : 'Guest',
      text: String(text).slice(0, 500),
      at: Date.now()
    });
  });

  // ---- Presence (mic/cam indicators) ----
  socket.on('presence:update', ({ mic, cam }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const member = room.members.get(socket.id);
    if (!member) return;
    if (typeof mic === 'boolean') member.mic = mic;
    if (typeof cam === 'boolean') member.cam = cam;
    io.to(currentRoomId).emit('presence:update', { id: socket.id, mic: member.mic, cam: member.cam });
  });

  // ---- WebRTC signaling relay (mesh: every peer connects to every peer) ----
  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });
  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });
  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.members.delete(socket.id);
    if (room.hostId === socket.id) {
      const next = room.members.keys().next();
      room.hostId = next.done ? null : next.value;
      // Tell whoever's left who the new host is, since it's used client-side
      // to decide who drives auto-advance-to-next-track (see queue:next below).
      io.to(currentRoomId).emit('host:update', { hostId: room.hostId });
    }
    socket.to(currentRoomId).emit('peer-left', { id: socket.id });
    cleanupEmptyRoom(currentRoomId);
  });
});

server.listen(PORT, () => {
  console.log(`SyncRoom server listening on http://localhost:${PORT}`);
});