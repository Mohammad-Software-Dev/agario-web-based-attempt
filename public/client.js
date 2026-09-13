const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const menu = document.getElementById('menu');
const hud = document.getElementById('hud');
const dead = document.getElementById('dead');
const form = document.getElementById('joinForm');
const nameInput = document.getElementById('name');
const stats = document.getElementById('stats');
const leaderboard = document.getElementById('leaderboard');
const deathScore = document.getElementById('deathScore');
const respawnBtn = document.getElementById('respawn');
const mobileControls = document.getElementById('mobileControls');

const BASE_SPEED = 420;
const WORLD_MARGIN = 8;
const INPUT_HZ = 45;
const PING_INTERVAL_MS = 1500;
const UI_INTERVAL_MS = 250;
const REMOTE_HISTORY_LIMIT = 12;

let ws = null;
let snapshot = null;
let selfId = null;
let joined = false;
let mouse = { x: innerWidth / 2, y: innerHeight / 2 };
let camera = { x: 3500, y: 3500, zoom: 1 };
let lastFrame = performance.now();
let lastAlive = true;
let pixelRatio = 1;
let cameraInitialized = false;
let backgroundGradient = null;
let lastUiUpdate = 0;
let lastSnapshotArrival = 0;
let snapshotInterval = 33.3;
let snapshotJitter = 0;
let rtt = 60;
let latestMass = 0;
let latestCellCount = 0;
let serverTimelineServer = null;
let serverTimelineLocal = null;

const visualCells = new Map();
const visualEjected = new Map();
const visualViruses = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const radius = mass => Math.sqrt(Math.max(1, mass)) * 4;
const speedFromMass = mass => BASE_SPEED / Math.pow(Math.max(10, mass), 0.12);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function resize() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const area = Math.max(1, innerWidth * innerHeight);
  const pixelBudgetCap = Math.sqrt((coarse ? 3_000_000 : 4_500_000) / area);
  pixelRatio = clamp(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2, pixelBudgetCap), 0.75, 2);
  canvas.width = Math.max(1, Math.floor(innerWidth * pixelRatio));
  canvas.height = Math.max(1, Math.floor(innerHeight * pixelRatio));
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  backgroundGradient = ctx.createRadialGradient(innerWidth * 0.5, innerHeight * 0.45, 0, innerWidth * 0.5, innerHeight * 0.45, Math.max(innerWidth, innerHeight) * 0.8);
  backgroundGradient.addColorStop(0, '#101d45');
  backgroundGradient.addColorStop(0.55, '#08152d');
  backgroundGradient.addColorStop(1, '#040a18');
}
addEventListener('resize', resize, { passive: true });
resize();

function connect(name) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', name }));
    sendPing();
  });
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'welcome') {
      selfId = message.id;
      joined = true;
      menu.classList.add('hidden');
      hud.classList.remove('hidden');
      if (matchMedia('(pointer: coarse)').matches) mobileControls.classList.remove('hidden');
      return;
    }
    if (message.type === 'pong') {
      const sample = performance.now() - Number(message.clientTime || 0);
      if (Number.isFinite(sample) && sample >= 0 && sample < 5000) rtt = rtt * 0.8 + sample * 0.2;
      return;
    }
    if (message.type === 'snapshot') onSnapshot(message);
  });
  ws.addEventListener('close', () => {
    if (joined) setTimeout(() => location.reload(), 900);
  });
}

form.addEventListener('submit', event => {
  event.preventDefault();
  connect(nameInput.value || 'Cell');
});

function sendPing() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'ping', clientTime: performance.now() }));
}
setInterval(sendPing, PING_INTERVAL_MS);

function updateNetworkTiming(arrival) {
  if (lastSnapshotArrival > 0) {
    const interval = arrival - lastSnapshotArrival;
    const error = Math.abs(interval - snapshotInterval);
    snapshotInterval = snapshotInterval * 0.9 + interval * 0.1;
    snapshotJitter = snapshotJitter * 0.84 + error * 0.16;
  }
  lastSnapshotArrival = arrival;
}

function mapServerTime(serverNow, arrival) {
  const value = Number(serverNow);
  if (!Number.isFinite(value)) return arrival;
  if (serverTimelineServer === null || serverTimelineLocal === null) {
    serverTimelineServer = value;
    serverTimelineLocal = arrival;
    return arrival;
  }
  const mapped = serverTimelineLocal + (value - serverTimelineServer);
  if (Math.abs(mapped - arrival) > 3000) {
    serverTimelineServer = value;
    serverTimelineLocal = arrival;
    return arrival;
  }
  return mapped;
}

function updateRemote(map, id, x, y, mass, sampleAt, extra = {}) {
  const sample = { at: sampleAt, x, y, mass };
  const current = map.get(id);
  if (!current) {
    map.set(id, {
      id, x, y, mass,
      history: [sample],
      vx: 0,
      vy: 0,
      ...extra,
    });
    return;
  }

  const history = current.history || (current.history = []);
  const previous = history[history.length - 1];
  if (previous && sample.at <= previous.at) sample.at = previous.at + 0.01;

  if (previous) {
    const jump = Math.hypot(sample.x - previous.x, sample.y - previous.y);
    if (jump > 900) {
      history.length = 0;
      current.x = sample.x;
      current.y = sample.y;
      current.mass = sample.mass;
      current.vx = 0;
      current.vy = 0;
    }
  }

  history.push(sample);
  while (history.length > REMOTE_HISTORY_LIMIT) history.shift();

  if (history.length >= 2) {
    const a = history[history.length - 2];
    const b = history[history.length - 1];
    const dt = clamp((b.at - a.at) / 1000, 1 / 120, 0.25);
    const measuredVx = clamp((b.x - a.x) / dt, -1400, 1400);
    const measuredVy = clamp((b.y - a.y) / dt, -1400, 1400);
    current.vx = current.vx * 0.5 + measuredVx * 0.5;
    current.vy = current.vy * 0.5 + measuredVy * 0.5;
  }

  Object.assign(current, extra);
}

function updateOwn(cell, player, arrival) {
  const current = visualCells.get(cell.id);
  if (!current) {
    visualCells.set(cell.id, {
      id: cell.id,
      ownerId: player.id,
      name: player.name,
      color: player.color,
      bot: player.bot,
      x: cell.x,
      y: cell.y,
      mass: cell.mass,
      serverX: cell.x,
      serverY: cell.y,
      serverMass: cell.mass,
      lastServerX: cell.x,
      lastServerY: cell.y,
      serverAt: arrival,
      serverVx: 0,
      serverVy: 0,
      boostUntilLocal: 0,
    });
    return;
  }

  const dt = clamp((arrival - current.serverAt) / 1000, 1 / 120, 0.25);
  const vx = (cell.x - current.serverX) / dt;
  const vy = (cell.y - current.serverY) / dt;
  const measuredSpeed = Math.hypot(vx, vy);
  const normalSpeed = speedFromMass(cell.mass);

  current.lastServerX = current.serverX;
  current.lastServerY = current.serverY;
  current.serverX = cell.x;
  current.serverY = cell.y;
  current.serverMass = cell.mass;
  current.serverAt = arrival;
  current.serverVx = current.serverVx * 0.3 + vx * 0.7;
  current.serverVy = current.serverVy * 0.3 + vy * 0.7;
  if (measuredSpeed > normalSpeed * 1.35) current.boostUntilLocal = arrival + 180;
  current.name = player.name;
  current.color = player.color;
  current.bot = player.bot;
}

function reconcileVisuals(s, arrival, sampleAt) {
  const seenCells = new Set();
  for (const player of s.players) {
    for (const cell of player.cells) {
      seenCells.add(cell.id);
      if (player.id === selfId) updateOwn(cell, player, arrival);
      else updateRemote(visualCells, cell.id, cell.x, cell.y, cell.mass, sampleAt, {
        ownerId: player.id,
        name: player.name,
        color: player.color,
        bot: player.bot,
      });
    }
  }
  for (const id of visualCells.keys()) if (!seenCells.has(id)) visualCells.delete(id);

  const seenEjected = new Set();
  for (const blob of s.ejected) {
    seenEjected.add(blob.id);
    updateRemote(visualEjected, blob.id, blob.x, blob.y, blob.mass, sampleAt, { color: blob.color });
  }
  for (const id of visualEjected.keys()) if (!seenEjected.has(id)) visualEjected.delete(id);

  const seenViruses = new Set();
  for (const virus of s.viruses) {
    seenViruses.add(virus.id);
    updateRemote(visualViruses, virus.id, virus.x, virus.y, virus.mass, sampleAt, { fed: virus.fed });
  }
  for (const id of visualViruses.keys()) if (!seenViruses.has(id)) visualViruses.delete(id);
}

function onSnapshot(s) {
  const arrival = performance.now();
  updateNetworkTiming(arrival);
  const sampleAt = mapServerTime(s.now, arrival);
  if (!Array.isArray(s.pellets) && Array.isArray(snapshot?.pellets)) s.pellets = snapshot.pellets;
  snapshot = s;
  reconcileVisuals(s, arrival, sampleAt);

  const me = s.players.find(player => player.id === selfId);
  const alive = !!me && me.cells.length > 0;
  if (me) {
    latestMass = me.cells.reduce((sum, cell) => sum + cell.mass, 0);
    latestCellCount = me.cells.length;
    deathScore.textContent = `Final mass: ${Math.round(latestMass)}`;
  }
  if (lastAlive && !alive) dead.classList.remove('hidden');
  if (!lastAlive && alive) dead.classList.add('hidden');
  lastAlive = alive;
}

function worldFromScreen(px, py) {
  return {
    x: camera.x + (px - innerWidth / 2) / camera.zoom,
    y: camera.y + (py - innerHeight / 2) / camera.zoom,
  };
}

function sendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !joined) return;
  const point = worldFromScreen(mouse.x, mouse.y);
  ws.send(JSON.stringify({ type: 'input', x: point.x, y: point.y }));
}
setInterval(sendInput, 1000 / INPUT_HZ);

canvas.addEventListener('pointermove', event => { mouse = { x: event.clientX, y: event.clientY }; }, { passive: true });
canvas.addEventListener('pointerdown', event => { mouse = { x: event.clientX, y: event.clientY }; }, { passive: true });

function action(type) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type }));
}
addEventListener('keydown', event => {
  if (event.repeat) return;
  if (event.code === 'Space') { event.preventDefault(); action('split'); }
  if (event.key.toLowerCase() === 'w') action('eject');
});
document.getElementById('splitBtn').addEventListener('click', () => action('split'));
document.getElementById('ejectBtn').addEventListener('click', () => action('eject'));
respawnBtn.addEventListener('click', () => action('respawn'));

function interpolationDelay() {
  return clamp(snapshotInterval * 2.8 + snapshotJitter * 3, 85, 160);
}

function velocityBetween(a, b) {
  const dt = Math.max(0.001, (b.at - a.at) / 1000);
  return {
    x: clamp((b.x - a.x) / dt, -1400, 1400),
    y: clamp((b.y - a.y) / dt, -1400, 1400),
  };
}

function hermite(p1, p2, v1, v2, t, segmentSeconds) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return {
    x: h00 * p1.x + h10 * v1.x * segmentSeconds + h01 * p2.x + h11 * v2.x * segmentSeconds,
    y: h00 * p1.y + h10 * v1.y * segmentSeconds + h01 * p2.y + h11 * v2.y * segmentSeconds,
  };
}

function interpolateRemote(entity, now) {
  const history = entity.history;
  if (!history?.length) return;

  const renderAt = now - interpolationDelay();
  const first = history[0];
  const latest = history[history.length - 1];

  if (history.length === 1 || renderAt <= first.at) {
    entity.x = first.x;
    entity.y = first.y;
    entity.mass = first.mass;
    return;
  }

  let upperIndex = -1;
  for (let i = 1; i < history.length; i++) {
    if (history[i].at >= renderAt) {
      upperIndex = i;
      break;
    }
  }

  if (upperIndex !== -1) {
    const p1 = history[upperIndex - 1];
    const p2 = history[upperIndex];
    const p0 = history[Math.max(0, upperIndex - 2)];
    const p3 = history[Math.min(history.length - 1, upperIndex + 1)];
    const segmentMs = Math.max(1, p2.at - p1.at);
    const segmentSeconds = segmentMs / 1000;
    const t = clamp((renderAt - p1.at) / segmentMs, 0, 1);

    const v1 = velocityBetween(p0, p2);
    const v2 = velocityBetween(p1, p3);
    const curved = hermite(p1, p2, v1, v2, t, segmentSeconds);
    const linearX = p1.x + (p2.x - p1.x) * t;
    const linearY = p1.y + (p2.y - p1.y) * t;
    const curveDx = curved.x - linearX;
    const curveDy = curved.y - linearY;
    const curveDistance = Math.hypot(curveDx, curveDy);
    const segmentDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const maxCurve = Math.max(2, segmentDistance * 0.22);
    const curveScale = curveDistance > maxCurve ? maxCurve / curveDistance : 1;

    entity.x = linearX + curveDx * curveScale;
    entity.y = linearY + curveDy * curveScale;
    entity.mass = p1.mass + (p2.mass - p1.mass) * t;
    return;
  }

  const overrunMs = renderAt - latest.at;
  if (overrunMs <= 35 && history.length >= 2) {
    const extra = overrunMs / 1000;
    entity.x = latest.x + entity.vx * extra;
    entity.y = latest.y + entity.vy * extra;
  } else {
    entity.x = latest.x;
    entity.y = latest.y;
  }
  entity.mass = latest.mass;
}

function predictOwn(cell, dt, now) {
  const target = worldFromScreen(mouse.x, mouse.y);
  const massBlend = 1 - Math.exp(-14 * dt);
  cell.mass += (cell.serverMass - cell.mass) * massBlend;

  if (now < cell.boostUntilLocal) {
    cell.x += cell.serverVx * dt;
    cell.y += cell.serverVy * dt;
  } else {
    const dx = target.x - cell.x;
    const dy = target.y - cell.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.001) {
      const r = radius(cell.mass);
      const throttle = clamp(distance / Math.max(r, 60), 0, 1);
      const speed = speedFromMass(cell.mass) * throttle;
      cell.x += dx / distance * speed * dt;
      cell.y += dy / distance * speed * dt;
    }
  }

  const oneWaySeconds = clamp(rtt / 2000 + snapshotInterval / 2000, 0.012, 0.11);
  const projectedX = cell.serverX + cell.serverVx * oneWaySeconds;
  const projectedY = cell.serverY + cell.serverVy * oneWaySeconds;
  const errorX = projectedX - cell.x;
  const errorY = projectedY - cell.y;
  const error = Math.hypot(errorX, errorY);
  const reconcileRate = error > 140 ? 16 : error > 70 ? 7 : 2.4;
  const correction = 1 - Math.exp(-reconcileRate * dt);
  cell.x += errorX * correction;
  cell.y += errorY * correction;

  if (snapshot) {
    const r = radius(cell.mass);
    cell.x = clamp(cell.x, r + WORLD_MARGIN, snapshot.world.width - r - WORLD_MARGIN);
    cell.y = clamp(cell.y, r + WORLD_MARGIN, snapshot.world.height - r - WORLD_MARGIN);
  }
}

function advanceVisuals(dt, now) {
  for (const cell of visualCells.values()) {
    if (cell.ownerId === selfId) predictOwn(cell, dt, now);
    else interpolateRemote(cell, now);
  }
  for (const entity of visualEjected.values()) interpolateRemote(entity, now);
  for (const entity of visualViruses.values()) interpolateRemote(entity, now);
}

function updateCamera(dt) {
  let total = 0;
  let weightedX = 0;
  let weightedY = 0;
  let ownCount = 0;
  for (const cell of visualCells.values()) {
    if (cell.ownerId !== selfId) continue;
    total += cell.mass;
    weightedX += cell.x * cell.mass;
    weightedY += cell.y * cell.mass;
    ownCount++;
  }
  if (!ownCount || total <= 0) return;

  const centerX = weightedX / total;
  const centerY = weightedY / total;
  const targetZoom = clamp(1.12 / Math.pow(total / 40, 0.09), 0.28, 1.05);
  if (!cameraInitialized) {
    camera.x = centerX;
    camera.y = centerY;
    camera.zoom = targetZoom;
    cameraInitialized = true;
    return;
  }

  const moveBlend = ownCount === 1 ? 1 : 1 - Math.exp(-18 * dt);
  const zoomBlend = 1 - Math.exp(-7 * dt);
  camera.x += (centerX - camera.x) * moveBlend;
  camera.y += (centerY - camera.y) * moveBlend;
  camera.zoom += (targetZoom - camera.zoom) * zoomBlend;
}

function updateUi(now, fps) {
  if (now - lastUiUpdate < UI_INTERVAL_MS || !snapshot) return;
  lastUiUpdate = now;
  stats.textContent = `Mass ${Math.round(latestMass)} · Cells ${latestCellCount} · ${Math.round(fps)} FPS · ${Math.round(rtt)} ms`;
  leaderboard.innerHTML = snapshot.leaderboard.map(entry =>
    `<li${entry.id === selfId ? ' class="self"' : ''}>${escapeHtml(entry.name)} <span>${entry.mass}</span></li>`
  ).join('');
}

function drawGrid(world) {
  const gap = 80;
  const scaledGap = gap * camera.zoom;
  const cx = innerWidth / 2 - camera.x * camera.zoom;
  const cy = innerHeight / 2 - camera.y * camera.zoom;
  ctx.save();
  ctx.strokeStyle = 'rgba(46, 196, 255, .10)';
  ctx.lineWidth = 1;
  const startX = ((cx % scaledGap) + scaledGap) % scaledGap;
  const startY = ((cy % scaledGap) + scaledGap) % scaledGap;
  for (let x = startX; x < innerWidth; x += scaledGap) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, innerHeight); ctx.stroke();
  }
  for (let y = startY; y < innerHeight; y += scaledGap) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(innerWidth, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0, 229, 255, .42)';
  ctx.lineWidth = 3;
  const point = toScreen(0, 0);
  ctx.strokeRect(point.x, point.y, world.width * camera.zoom, world.height * camera.zoom);
  ctx.restore();
}

function toScreen(x, y) {
  return {
    x: (x - camera.x) * camera.zoom + innerWidth / 2,
    y: (y - camera.y) * camera.zoom + innerHeight / 2,
  };
}

function drawCircle(x, y, r, fill, stroke = 'rgba(255,255,255,.34)', lineWidth = 2) {
  const point = toScreen(x, y);
  const rr = r * camera.zoom;
  if (point.x + rr < 0 || point.x - rr > innerWidth || point.y + rr < 0 || point.y - rr > innerHeight) return;
  ctx.beginPath();
  ctx.arc(point.x, point.y, rr, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function drawVirus(virus) {
  const point = toScreen(virus.x, virus.y);
  const r = radius(virus.mass) * camera.zoom;
  const spikes = 24;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const angle = i * Math.PI / spikes;
    const rr = i % 2 ? r * 0.84 : r * 1.08;
    const x = point.x + Math.cos(angle) * rr;
    const y = point.y + Math.sin(angle) * rr;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#20e978';
  ctx.fill();
  ctx.strokeStyle = '#b7ffd1';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function draw() {
  const now = performance.now();
  const frameMs = clamp(now - lastFrame, 1, 50);
  const dt = frameMs / 1000;
  const instantaneousFps = 1000 / frameMs;
  draw.fps = (draw.fps || 60) * 0.92 + instantaneousFps * 0.08;
  lastFrame = now;

  advanceVisuals(dt, now);
  updateCamera(dt);
  updateUi(now, draw.fps);

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = backgroundGradient || '#040a18';
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  if (snapshot) {
    drawGrid(snapshot.world);
    for (const pellet of snapshot.pellets) drawCircle(pellet.x, pellet.y, 5.3, pellet.color, null, 0);
    for (const blob of visualEjected.values()) drawCircle(blob.x, blob.y, radius(blob.mass), blob.color, 'rgba(255,255,255,.55)', 1.25);
    for (const virus of visualViruses.values()) drawVirus(virus);

    const ordered = Array.from(visualCells.values());
    ordered.sort((a, b) => b.mass - a.mass);
    for (const cell of ordered) {
      const r = radius(cell.mass);
      const isSelf = cell.ownerId === selfId;
      drawCircle(cell.x, cell.y, r, cell.color, isSelf ? '#ffffff' : 'rgba(255,255,255,.38)', isSelf ? 3 : 2);
      const point = toScreen(cell.x, cell.y);
      const rr = r * camera.zoom;
      if (rr > 18) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.font = `800 ${Math.max(10, Math.min(24, rr * 0.32))}px system-ui`;
        ctx.fillText(cell.name, point.x, point.y - (rr > 34 ? 6 : 0));
        if (rr > 34) {
          ctx.font = `700 ${Math.max(9, Math.min(15, rr * 0.2))}px system-ui`;
          ctx.globalAlpha = 0.82;
          ctx.fillText(Math.round(cell.mass), point.x, point.y + 14);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
