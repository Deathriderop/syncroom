# SyncRoom

A shared room where people can listen to YouTube together in perfect sync, talk over
voice/video, and chat — without the music ever passing through a low-quality voice pipe.

## Why it works this way (quick recap)

- **Music** plays through YouTube's own embedded player on *each person's device*.
  The server never touches the actual audio — it only relays tiny "play at position X"
  / "pause" / "seek" messages. So sound quality is exactly whatever YouTube serves,
  untouched by this app.
- **Voice/video** uses WebRTC in a mesh: everyone connects directly to everyone else.
  The server only helps peers *find* each other (signaling) — audio/video bytes never
  pass through it either. This keeps voice quality independent of the music entirely,
  which is the actual fix for the "Discord music sounds crushed" problem — that happens
  when music gets routed through a voice-optimized codec path. Here it never does.
- **Works on desktop and mobile** because it's a responsive web app, not two separate
  native apps. Open the same URL on a phone or a laptop and it adapts.

## Project structure

```
syncroom/
  server/
    server.js      # room state, music sync relay, WebRTC signaling relay, chat
    package.json
  public/
    index.html
    style.css
    app.js          # YouTube player control, WebRTC mesh, queue, chat — all client-side
```

## Running it locally

```bash
cd server
npm install
npm start
```

Then open **http://localhost:3000** in a browser. Open it in a second tab (or on your
phone, using your computer's local IP instead of localhost) to test with more than
one person.

## Using it

1. Enter a name and a room code (or hit the ⟳ to generate one) → **Enter room**.
2. Hit **Copy invite** to share the room link with others.
3. Paste any YouTube video link into the "Add" box to queue it — no API key needed.
4. To import a **whole playlist** by link, you need a free YouTube Data API v3 key
   (see below) — paste it in on the join screen. It's stored only in your own browser.
5. Toggle **Mic**/**Camera** to join the call. Anyone in the room can hit play/pause/
   skip/seek — it syncs for everyone.

## Getting a YouTube Data API v3 key (only needed for playlist import)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or use an existing one).
3. Enable **YouTube Data API v3** under "APIs & Services".
4. Create an API key under "Credentials".
5. Paste it into the join screen's API key field.

Single-video adds work without any key at all (using YouTube's public oEmbed endpoint
for the title).

## Deploying so others can join from anywhere

Right now this only runs on your local network. To make it reachable from the internet:

- Deploy `server/` to any Node host (Render, Railway, Fly.io, a small VPS, etc.) —
  it's a standard Express + Socket.io app, nothing exotic.
- Set `PORT` via environment variable if your host requires it (already wired up).
- Serve over **HTTPS** — required both for `getUserMedia` (mic/camera access) and
  for WebRTC to work reliably outside of localhost.
- Update the CORS origin in `server.js` (`origin: '*'`) to your real domain once deployed.

## Known limitations worth knowing about (and how to grow past them)

- **WebRTC mesh** (everyone connects to everyone) works great for small groups
  (roughly up to 6–8 people). Beyond that, connections and CPU load add up fast.
  For larger rooms, swap in an SFU (LiveKit, mediasoup) — you'd keep the same
  signaling pattern, just route media through one relay instead of a full mesh.
- **NAT traversal**: the included STUN server (Google's public one) gets most
  peer-to-peer connections through, but some strict corporate/mobile networks need
  a TURN server as a fallback. Services like Twilio or metered.ca offer this cheaply,
  or you can self-host coturn.
- **Playback authority**: right now anyone in the room can control play/pause/seek,
  which is simple and fine for friends. If you want a "host only" mode, the server
  already tracks `hostId` per room — just gate the `music:*` handlers on it.
- **Mobile background audio**: some mobile browsers pause embedded YouTube players
  when the tab isn't visible or the phone is locked. Worth testing on your target
  devices early — this is a browser/OS policy, not something the app controls.
