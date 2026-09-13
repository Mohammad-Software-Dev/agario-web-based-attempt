import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Game } from './game.js';
import type { SocketLike } from './types.js';
import { sanitizeName } from './sanitize.js';

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : fallback;
};
const PORT = num('PORT', 3000);
const TICK_RATE = Math.min(60, num('TICK_RATE', 30));
const SNAPSHOT_RATE = Math.min(TICK_RATE, num('SNAPSHOT_RATE', 30));
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(v => v.trim()).filter(Boolean);

const game = new Game({
  worldWidth: num('WORLD_WIDTH', 7000), worldHeight: num('WORLD_HEIGHT', 7000),
  foodCount: num('FOOD_COUNT', 900), virusCount: num('VIRUS_COUNT', 28), botCount: num('BOT_COUNT', 18),
  tickRate: TICK_RATE, snapshotRate: SNAPSHOT_RATE,
});

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc:["'self'"], connectSrc:["'self'", 'ws:', 'wss:'], styleSrc:["'self'", "'unsafe-inline'"], imgSrc:["'self'", 'data:'] } } }));
app.use(compression());
app.get('/healthz', (_req, res) => res.json({ ok: true, players: [...game.players.values()].filter(p=>!p.isBot).length, bots: [...game.players.values()].filter(p=>p.isBot).length, uptime: process.uptime() }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
app.use(express.static(root, {
  maxAge: 0,
  etag: true,
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
}));
app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(root, 'index.html'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });

function send(ws: SocketLike, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws, req) => {
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 15000);
  const origin = req.headers.origin;
  if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) { ws.close(1008, 'origin not allowed'); return; }
  let player: ReturnType<Game['addPlayer']> | null = null;
  let alive = true;
  ws.on('pong', () => { alive = true; });

  ws.on('message', raw => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg?.type === 'ping') {
      send(ws, { type: 'pong', clientTime: Number(msg.clientTime) || 0 });
      return;
    }

    if (!player) {
      if (msg?.type !== 'join') return;
      player = game.addPlayer(sanitizeName(msg.name));
      player.ws = ws;
      send(ws, { type: 'welcome', id: player.id });
      return;
    }
    const now = Date.now();
    if (now - player.inputWindowStartedAt > 1000) { player.inputWindowStartedAt = now; player.inputCountWindow = 0; }
    if (++player.inputCountWindow > 120) return;
    if (msg?.type === 'input') game.setTarget(player, Number(msg.x), Number(msg.y));
    else if (msg?.type === 'split') game.split(player, now);
    else if (msg?.type === 'eject') game.eject(player, now);
    else if (msg?.type === 'respawn' && !player.alive) game.respawn(player);
  });
  ws.on('close', () => { if (player) game.removePlayer(player.id); });
  ws.on('error', () => { /* close handles cleanup */ });

  const heartbeat = setInterval(() => {
    if (!alive) { clearInterval(heartbeat); ws.terminate(); return; }
    alive = false; ws.ping();
  }, 15000);
  ws.on('close', () => clearInterval(heartbeat));
});

let previous = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - previous) / 1000); previous = now;
  game.tick(dt, Date.now());
}, 1000 / TICK_RATE);

const snapshotCounters = new WeakMap<object, number>();
const pelletStride = Math.max(1, Math.round(SNAPSHOT_RATE / 10));
setInterval(() => {
  for (const player of game.players.values()) {
    if (player.isBot || !player.ws) continue;
    const socket = player.ws as WebSocket;
    if (socket.readyState !== WebSocket.OPEN) continue;

    // Never build an ever-growing queue of stale world states. If the connection
    // is congested, dropping an intermediate snapshot is better than showing it late.
    if (socket.bufferedAmount > 64 * 1024) continue;

    const state: any = game.snapshotFor(player);
    const count = (snapshotCounters.get(socket) ?? 0) + 1;
    snapshotCounters.set(socket, count);
    // Pellets are numerous and mostly static. Refresh them around 10 Hz while
    // movement state follows the simulation tick rate for smoother remote motion.
    if ((count - 1) % pelletStride !== 0) delete state.pellets;
    send(socket, state);
  }
}, 1000 / SNAPSHOT_RATE);

server.listen(PORT, () => console.log(`Cell Arena listening on http://localhost:${PORT}`));
