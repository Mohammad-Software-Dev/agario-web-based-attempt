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

let ws = null;
let snapshot = null;
let selfId = null;
let joined = false;
let mouse = { x: innerWidth / 2, y: innerHeight / 2 };
let camera = { x: 3500, y: 3500, zoom: 1 };
let lastFrame = performance.now();
let lastSnapshotArrival = performance.now();
let fps = 60;
let lastAlive = true;
let pixelRatio = 1;
let cameraInitialized = false;
let backgroundGradient = null;

const visualCells = new Map();
const visualEjected = new Map();
const visualViruses = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const radius = mass => Math.sqrt(Math.max(1, mass)) * 4;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function resize() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  pixelRatio = Math.min(devicePixelRatio || 1, coarse ? 1.6 : 2);
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
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', name })));
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'welcome') {
      selfId = message.id;
      joined = true;
      menu.classList.add('hidden');
      hud.classList.remove('hidden');
      if (matchMedia('(pointer: coarse)').matches) mobileControls.classList.remove('hidden');
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

function updateVisual(map, id, x, y, mass, serverNow, extra = {}) {
  const current = map.get(id);
  if (!current) {
    map.set(id, { id, x, y, mass, tx: x, ty: y, tmass: mass, vx: 0, vy: 0, serverNow, ...extra });
    return;
  }

  const elapsed = clamp((serverNow - current.serverNow) / 1000, 1 / 120, 0.25);
  const dx = x - current.tx;
  const dy = y - current.ty;
  const jump = Math.hypot(dx, dy);

  if (jump > 700) {
    current.x = x;
    current.y = y;
    current.vx = 0;
    current.vy = 0;
  } else {
    const measuredVx = dx / elapsed;
    const measuredVy = dy / elapsed;
    current.vx = current.vx * 0.35 + measuredVx * 0.65;
    current.vy = current.vy * 0.35 + measuredVy * 0.65;
    const speed = Math.hypot(current.vx, current.vy);
    if (speed > 1200) {
      const scale = 1200 / speed;
      current.vx *= scale;
      current.vy *= scale;
    }
  }

  current.tx = x;
  current.ty = y;
  current.tmass = mass;
  current.serverNow = serverNow;
  Object.assign(current, extra);
}

function reconcileVisuals(s) {
  const seenCells = new Set();
  for (const player of s.players) {
    for (const cell of player.cells) {
      seenCells.add(cell.id);
      updateVisual(visualCells, cell.id, cell.x, cell.y, cell.mass, s.now, {
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
    updateVisual(visualEjected, blob.id, blob.x, blob.y, blob.mass, s.now, { color: blob.color });
  }
  for (const id of visualEjected.keys()) if (!seenEjected.has(id)) visualEjected.delete(id);

  const seenViruses = new Set();
  for (const virus of s.viruses) {
    seenViruses.add(virus.id);
    updateVisual(visualViruses, virus.id, virus.x, virus.y, virus.mass, s.now, { fed: virus.fed });
  }
  for (const id of visualViruses.keys()) if (!seenViruses.has(id)) visualViruses.delete(id);
}

function onSnapshot(s) {
  snapshot = s;
  lastSnapshotArrival = performance.now();
  reconcileVisuals(s);

  const me = s.players.find(player => player.id === selfId);
  const alive = !!me && me.cells.length > 0;
  if (me) {
    const total = me.cells.reduce((sum, cell) => sum + cell.mass, 0);
    stats.textContent = `Mass ${Math.round(total)} · Cells ${me.cells.length} · ${Math.round(fps)} FPS`;
    deathScore.textContent = `Final mass: ${Math.round(total)}`;
  }
  if (lastAlive && !alive) dead.classList.remove('hidden');
  if (!lastAlive && alive) dead.classList.add('hidden');
  lastAlive = alive;

  leaderboard.innerHTML = s.leaderboard.map(entry =>
    `<li${entry.id === selfId ? ' class="self"' : ''}>${escapeHtml(entry.name)} <span>${entry.mass}</span></li>`
  ).join('');
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
setInterval(sendInput, 1000 / 30);

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

function advanceVisuals(dt, now) {
  const snapshotAge = clamp((now - lastSnapshotArrival) / 1000, 0, 0.11);
  for (const cell of visualCells.values()) {
    const self = cell.ownerId === selfId;
    const desiredX = cell.tx + cell.vx * snapshotAge;
    const desiredY = cell.ty + cell.vy * snapshotAge;
    const positionRate = self ? 22 : 15;
    const positionBlend = 1 - Math.exp(-positionRate * dt);
    const massBlend = 1 - Math.exp(-12 * dt);
    cell.x += (desiredX - cell.x) * positionBlend;
    cell.y += (desiredY - cell.y) * positionBlend;
    cell.mass += (cell.tmass - cell.mass) * massBlend;
  }

  for (const map of [visualEjected, visualViruses]) {
    for (const entity of map.values()) {
      const desiredX = entity.tx + entity.vx * snapshotAge;
      const desiredY = entity.ty + entity.vy * snapshotAge;
      const blend = 1 - Math.exp(-18 * dt);
      entity.x += (desiredX - entity.x) * blend;
      entity.y += (desiredY - entity.y) * blend;
      entity.mass += (entity.tmass - entity.mass) * (1 - Math.exp(-10 * dt));
    }
  }
}

function updateCamera(dt) {
  const ownCells = [...visualCells.values()].filter(cell => cell.ownerId === selfId);
  if (!ownCells.length) return;
  const total = ownCells.reduce((sum, cell) => sum + cell.mass, 0);
  if (total <= 0) return;
  const centerX = ownCells.reduce((sum, cell) => sum + cell.x * cell.mass, 0) / total;
  const centerY = ownCells.reduce((sum, cell) => sum + cell.y * cell.mass, 0) / total;
  const targetZoom = clamp(1.12 / Math.pow(total / 40, 0.09), 0.28, 1.05);

  if (!cameraInitialized) {
    camera.x = centerX;
    camera.y = centerY;
    camera.zoom = targetZoom;
    cameraInitialized = true;
    return;
  }

  const moveBlend = 1 - Math.exp(-9 * dt);
  const zoomBlend = 1 - Math.exp(-6 * dt);
  camera.x += (centerX - camera.x) * moveBlend;
  camera.y += (centerY - camera.y) * moveBlend;
  camera.zoom += (targetZoom - camera.zoom) * zoomBlend;
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

function drawCircle(x, y, r, fill, stroke = 'rgba(255,255,255,.34)', lineWidth = 2, glow = false) {
  const point = toScreen(x, y);
  const rr = r * camera.zoom;
  if (point.x + rr < 0 || point.x - rr > innerWidth || point.y + rr < 0 || point.y - rr > innerHeight) return;
  if (glow && rr > 8) {
    ctx.shadowColor = fill;
    ctx.shadowBlur = Math.min(18, Math.max(4, rr * 0.2));
  } else {
    ctx.shadowBlur = 0;
  }
  ctx.beginPath();
  ctx.arc(point.x, point.y, rr, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;
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
  ctx.save();
  ctx.shadowColor = '#39ff88';
  ctx.shadowBlur = Math.min(22, r * 0.25);
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
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#b7ffd1';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function draw() {
  const now = performance.now();
  const frameMs = clamp(now - lastFrame, 1, 50);
  const dt = frameMs / 1000;
  fps = fps * 0.92 + (1000 / frameMs) * 0.08;
  lastFrame = now;

  advanceVisuals(dt, now);
  updateCamera(dt);

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = backgroundGradient || '#040a18';
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  if (snapshot) {
    drawGrid(snapshot.world);

    for (const pellet of snapshot.pellets) drawCircle(pellet.x, pellet.y, 5.3, pellet.color, null, 0, true);
    for (const blob of visualEjected.values()) drawCircle(blob.x, blob.y, radius(blob.mass), blob.color, 'rgba(255,255,255,.55)', 1.25, true);
    for (const virus of visualViruses.values()) drawVirus(virus);

    const ordered = [...visualCells.values()].sort((a, b) => b.mass - a.mass);
    for (const cell of ordered) {
      const r = radius(cell.mass);
      const isSelf = cell.ownerId === selfId;
      drawCircle(cell.x, cell.y, r, cell.color, isSelf ? '#ffffff' : 'rgba(255,255,255,.38)', isSelf ? 3 : 2, true);
      const point = toScreen(cell.x, cell.y);
      const rr = r * camera.zoom;
      if (rr > 18) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,.65)';
        ctx.shadowBlur = 5;
        ctx.font = `800 ${Math.max(10, Math.min(24, rr * 0.32))}px system-ui`;
        ctx.fillText(cell.name, point.x, point.y - (rr > 34 ? 6 : 0));
        if (rr > 34) {
          ctx.font = `700 ${Math.max(9, Math.min(15, rr * 0.2))}px system-ui`;
          ctx.globalAlpha = 0.82;
          ctx.fillText(Math.round(cell.mass), point.x, point.y + 14);
          ctx.globalAlpha = 1;
        }
        ctx.shadowBlur = 0;
      }
    }
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
