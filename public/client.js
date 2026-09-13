const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const menu = document.getElementById('menu');
const hud = document.getElementById('hud');
const dead = document.getElementById('dead');
const form = document.getElementById('joinForm');
const nameInput = document.getElementById('name');
const scoreValue = document.getElementById('scoreValue');
const stats = document.getElementById('stats');
const leaderboard = document.getElementById('leaderboard');
const deathScore = document.getElementById('deathScore');
const respawnBtn = document.getElementById('respawn');
const mobileControls = document.getElementById('mobileControls');
const minimap = document.getElementById('minimap');
const minimapCtx = minimap.getContext('2d', { alpha: true });
const themeToggle = document.getElementById('themeToggle');

const BASE_SPEED = 420;
const WORLD_MARGIN = 8;
const INPUT_HZ = 45;
const PING_INTERVAL_MS = 1500;
const UI_INTERVAL_MS = 200;
const MINIMAP_INTERVAL_MS = 100;
const REMOTE_HISTORY_LIMIT = 10;
const SIBLING_PADDING = 0.75;
const SIBLING_SOLVER_PASSES = 8;

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
let vignetteGradient = null;
let lastUiUpdate = 0;
let lastMinimapUpdate = 0;
let lastSnapshotArrival = 0;
let snapshotInterval = 33.3;
let snapshotJitter = 0;
let rtt = 60;
let latestMass = 0;
let latestCellCount = 0;
let fps = 60;
let theme = localStorage.getItem('cell-arena-theme');
if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

const visualCells = new Map();
const visualEjected = new Map();
const visualViruses = new Map();
const colorCache = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const radius = mass => Math.sqrt(Math.max(1, mass)) * 4;
const speedFromMass = mass => BASE_SPEED / Math.pow(Math.max(10, mass), 0.12);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function colorParts(color) {
  const key = String(color || '#ffffff').toLowerCase();
  const cached = colorCache.get(key);
  if (cached) return cached;
  let hex = key.startsWith('#') ? key.slice(1) : 'ffffff';
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) hex = 'ffffff';
  const parts = {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
  colorCache.set(key, parts);
  return parts;
}

function mixColor(color, target, amount, alpha = 1) {
  const c = colorParts(color);
  const t = target === 'white' ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const a = clamp(amount, 0, 1);
  const r = Math.round(c.r + (t.r - c.r) * a);
  const g = Math.round(c.g + (t.g - c.g) * a);
  const b = Math.round(c.b + (t.b - c.b) * a);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

function colorAlpha(color, alpha) {
  const c = colorParts(color);
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

function seededUnit(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function rebuildBackground() {
  backgroundGradient = ctx.createRadialGradient(
    innerWidth * 0.48, innerHeight * 0.38, 0,
    innerWidth * 0.5, innerHeight * 0.5, Math.max(innerWidth, innerHeight) * 0.84,
  );
  vignetteGradient = ctx.createRadialGradient(
    innerWidth * 0.5, innerHeight * 0.5, Math.min(innerWidth, innerHeight) * 0.2,
    innerWidth * 0.5, innerHeight * 0.5, Math.max(innerWidth, innerHeight) * 0.74,
  );
  if (theme === 'light') {
    backgroundGradient.addColorStop(0, '#fbfdff');
    backgroundGradient.addColorStop(0.58, '#eef6ff');
    backgroundGradient.addColorStop(1, '#dbe8f6');
    vignetteGradient.addColorStop(0, 'rgba(255,255,255,0)');
    vignetteGradient.addColorStop(1, 'rgba(49,91,132,.10)');
  } else {
    backgroundGradient.addColorStop(0, '#142653');
    backgroundGradient.addColorStop(0.55, '#091932');
    backgroundGradient.addColorStop(1, '#030814');
    vignetteGradient.addColorStop(0, 'rgba(0,0,0,0)');
    vignetteGradient.addColorStop(1, 'rgba(0,0,0,.28)');
  }
}

function applyTheme(nextTheme) {
  theme = nextTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('cell-arena-theme', theme);
  themeToggle.textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
  themeToggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  rebuildBackground();
}

themeToggle.addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));
applyTheme(theme);

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
  rebuildBackground();

  const miniCssSize = Math.min(180, Math.max(132, innerWidth * 0.15));
  const miniRatio = Math.min(devicePixelRatio || 1, 2);
  minimap.style.width = `${miniCssSize}px`;
  minimap.style.height = `${miniCssSize}px`;
  minimap.width = Math.round(miniCssSize * miniRatio);
  minimap.height = Math.round(miniCssSize * miniRatio);
  minimap.dataset.cssSize = String(miniCssSize);
  minimap.dataset.ratio = String(miniRatio);
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
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

function updatePassiveEntity(map, id, x, y, mass, arrival, extra = {}) {
  const sample = { at: arrival, x, y, mass };
  const current = map.get(id);
  if (!current) {
    map.set(id, { id, x, y, mass, history: [sample], vx: 0, vy: 0, ...extra });
    return;
  }
  const history = current.history || (current.history = []);
  const previous = history[history.length - 1];
  history.push(sample);
  while (history.length > REMOTE_HISTORY_LIMIT) history.shift();
  if (previous) {
    const dt = clamp((arrival - previous.at) / 1000, 1 / 120, 0.25);
    current.vx = current.vx * 0.45 + clamp((x - previous.x) / dt, -1600, 1600) * 0.55;
    current.vy = current.vy * 0.45 + clamp((y - previous.y) / dt, -1600, 1600) * 0.55;
  }
  Object.assign(current, extra);
}

function newPredictedCell(cell, player, arrival) {
  return {
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
    serverAt: arrival,
    serverVx: Number(cell.vx) || 0,
    serverVy: Number(cell.vy) || 0,
    predictedVx: Number(cell.vx) || 0,
    predictedVy: Number(cell.vy) || 0,
    boostUntilLocal: arrival + Math.max(0, Number(cell.boostMs) || 0),
    mergeUntilLocal: arrival + Math.max(0, Number(cell.mergeMs) || 0),
    targetX: Number(player.target?.x) || cell.x,
    targetY: Number(player.target?.y) || cell.y,
  };
}

function updatePredictedCell(cell, player, arrival) {
  let current = visualCells.get(cell.id);
  if (!current || current.ownerId !== player.id) {
    current = newPredictedCell(cell, player, arrival);
    visualCells.set(cell.id, current);
    return;
  }

  const dt = clamp((arrival - current.serverAt) / 1000, 1 / 120, 0.25);
  const measuredVx = (cell.x - current.serverX) / dt;
  const measuredVy = (cell.y - current.serverY) / dt;
  const reportedVx = Number(cell.vx);
  const reportedVy = Number(cell.vy);

  current.serverX = cell.x;
  current.serverY = cell.y;
  current.serverMass = cell.mass;
  current.serverAt = arrival;
  current.serverVx = Number.isFinite(reportedVx) ? reportedVx : current.serverVx * 0.35 + measuredVx * 0.65;
  current.serverVy = Number.isFinite(reportedVy) ? reportedVy : current.serverVy * 0.35 + measuredVy * 0.65;
  current.targetX = Number.isFinite(Number(player.target?.x)) ? Number(player.target.x) : current.targetX;
  current.targetY = Number.isFinite(Number(player.target?.y)) ? Number(player.target.y) : current.targetY;
  current.name = player.name;
  current.color = player.color;
  current.bot = player.bot;
  current.mergeUntilLocal = arrival + Math.max(0, Number(cell.mergeMs) || 0);

  const boostMs = Math.max(0, Number(cell.boostMs) || 0);
  if (boostMs > 0) {
    current.boostUntilLocal = arrival + boostMs;
    current.predictedVx = current.serverVx;
    current.predictedVy = current.serverVy;
  } else if (current.boostUntilLocal <= arrival) {
    current.boostUntilLocal = 0;
  }
}

function reconcileVisuals(s, arrival) {
  const seenCells = new Set();
  for (const player of s.players) {
    for (const cell of player.cells) {
      seenCells.add(cell.id);
      updatePredictedCell(cell, player, arrival);
    }
  }
  for (const id of visualCells.keys()) if (!seenCells.has(id)) visualCells.delete(id);

  const seenEjected = new Set();
  for (const blob of s.ejected) {
    seenEjected.add(blob.id);
    updatePassiveEntity(visualEjected, blob.id, blob.x, blob.y, blob.mass, arrival, { color: blob.color });
  }
  for (const id of visualEjected.keys()) if (!seenEjected.has(id)) visualEjected.delete(id);

  const seenViruses = new Set();
  for (const virus of s.viruses) {
    seenViruses.add(virus.id);
    updatePassiveEntity(visualViruses, virus.id, virus.x, virus.y, virus.mass, arrival, { fed: virus.fed });
  }
  for (const id of visualViruses.keys()) if (!seenViruses.has(id)) visualViruses.delete(id);
}

function onSnapshot(s) {
  const arrival = performance.now();
  updateNetworkTiming(arrival);
  if (!Array.isArray(s.pellets) && Array.isArray(snapshot && snapshot.pellets)) s.pellets = snapshot.pellets;
  if (!Array.isArray(s.minimap) && Array.isArray(snapshot && snapshot.minimap)) s.minimap = snapshot.minimap;
  snapshot = s;
  reconcileVisuals(s, arrival);

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
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type }));
}
addEventListener('keydown', event => {
  if (event.repeat) return;
  if (event.code === 'Space') { event.preventDefault(); action('split'); }
  if (event.key.toLowerCase() === 'w') action('eject');
});
document.getElementById('splitBtn').addEventListener('click', () => action('split'));
document.getElementById('ejectBtn').addEventListener('click', () => action('eject'));
respawnBtn.addEventListener('click', () => action('respawn'));

function targetForCell(cell) {
  if (cell.ownerId === selfId) return worldFromScreen(mouse.x, mouse.y);
  return { x: cell.targetX, y: cell.targetY };
}

function projectServerState(cell, seconds, now) {
  let x = cell.serverX;
  let y = cell.serverY;
  let vx = cell.serverVx;
  let vy = cell.serverVy;
  const mass = Math.max(1, cell.serverMass);
  const boostRemaining = Math.max(0, cell.boostUntilLocal - now) / 1000;
  const boostStep = Math.min(seconds, boostRemaining);
  if (boostStep > 0) {
    x += vx * boostStep;
    y += vy * boostStep;
    vx *= Math.pow(0.02, boostStep);
    vy *= Math.pow(0.02, boostStep);
  }
  const normalStep = seconds - boostStep;
  if (normalStep > 0) {
    const dx = cell.targetX - x;
    const dy = cell.targetY - y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.001) {
      const throttle = clamp(distance / Math.max(radius(mass), 60), 0, 1);
      const speed = speedFromMass(mass) * throttle;
      x += dx / distance * speed * normalStep;
      y += dy / distance * speed * normalStep;
    }
  }
  return { x, y };
}

function predictPlayerCell(cell, dt, now) {
  const massBlend = 1 - Math.exp(-14 * dt);
  cell.mass += (cell.serverMass - cell.mass) * massBlend;

  if (now < cell.boostUntilLocal) {
    cell.x += cell.predictedVx * dt;
    cell.y += cell.predictedVy * dt;
    cell.predictedVx *= Math.pow(0.02, dt);
    cell.predictedVy *= Math.pow(0.02, dt);
  } else {
    const target = targetForCell(cell);
    const dx = target.x - cell.x;
    const dy = target.y - cell.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.001) {
      const throttle = clamp(distance / Math.max(radius(cell.mass), 60), 0, 1);
      const speed = speedFromMass(cell.mass) * throttle;
      cell.x += dx / distance * speed * dt;
      cell.y += dy / distance * speed * dt;
    }
  }

  const horizon = clamp(rtt / 2000 + snapshotInterval / 2000, 0.012, 0.105);
  const projected = projectServerState(cell, horizon, now);
  const errorX = projected.x - cell.x;
  const errorY = projected.y - cell.y;
  const error = Math.hypot(errorX, errorY);
  const reconcileRate = error > 160 ? 15 : error > 80 ? 6.5 : 2.2;
  const correction = 1 - Math.exp(-reconcileRate * dt);
  cell.x += errorX * correction;
  cell.y += errorY * correction;

  if (snapshot) {
    const r = radius(cell.mass);
    cell.x = clamp(cell.x, r + WORLD_MARGIN, snapshot.world.width - r - WORLD_MARGIN);
    cell.y = clamp(cell.y, r + WORLD_MARGIN, snapshot.world.height - r - WORLD_MARGIN);
  }
}

function resolveVisualSiblingCollisions(now) {
  if (!snapshot || visualCells.size < 2) return;
  const byOwner = new Map();
  for (const cell of visualCells.values()) {
    let group = byOwner.get(cell.ownerId);
    if (!group) {
      group = [];
      byOwner.set(cell.ownerId, group);
    }
    group.push(cell);
  }

  for (const cells of byOwner.values()) {
    if (cells.length < 2) continue;
    for (let pass = 0; pass < SIBLING_SOLVER_PASSES; pass++) {
      let corrected = false;
      for (let i = 0; i < cells.length; i++) {
        const a = cells[i];
        for (let j = i + 1; j < cells.length; j++) {
          const b = cells[j];
          if (now >= a.mergeUntilLocal && now >= b.mergeUntilLocal) continue;

          const ar = radius(a.mass);
          const br = radius(b.mass);
          const minDistance = ar + br + SIBLING_PADDING;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance >= minDistance) continue;

          let nx;
          let ny;
          if (distance < 0.0001) {
            const angle = (((a.id * 0.754877666 + b.id * 0.569840296 + pass * 0.17320508) % 1) + 1) % 1 * Math.PI * 2;
            nx = Math.cos(angle);
            ny = Math.sin(angle);
            distance = 0;
          } else {
            nx = dx / distance;
            ny = dy / distance;
          }

          const overlap = minDistance - distance;
          const totalRadius = Math.max(0.0001, ar + br);
          a.x -= nx * overlap * (br / totalRadius);
          a.y -= ny * overlap * (br / totalRadius);
          b.x += nx * overlap * (ar / totalRadius);
          b.y += ny * overlap * (ar / totalRadius);

          a.x = clamp(a.x, ar + WORLD_MARGIN, snapshot.world.width - ar - WORLD_MARGIN);
          a.y = clamp(a.y, ar + WORLD_MARGIN, snapshot.world.height - ar - WORLD_MARGIN);
          b.x = clamp(b.x, br + WORLD_MARGIN, snapshot.world.width - br - WORLD_MARGIN);
          b.y = clamp(b.y, br + WORLD_MARGIN, snapshot.world.height - br - WORLD_MARGIN);
          corrected = true;
        }
      }
      if (!corrected) break;
    }
  }
}

function interpolationDelay() {
  return clamp(snapshotInterval * 2.2 + snapshotJitter * 2.5, 58, 125);
}

function interpolatePassive(entity, now) {
  const history = entity.history;
  if (!history || !history.length) return;
  const renderAt = now - interpolationDelay();
  if (history.length === 1 || renderAt <= history[0].at) {
    entity.x = history[0].x;
    entity.y = history[0].y;
    entity.mass = history[0].mass;
    return;
  }
  for (let i = 1; i < history.length; i++) {
    const b = history[i];
    if (b.at < renderAt) continue;
    const a = history[i - 1];
    const t = clamp((renderAt - a.at) / Math.max(1, b.at - a.at), 0, 1);
    const smooth = t * t * (3 - 2 * t);
    entity.x = a.x + (b.x - a.x) * smooth;
    entity.y = a.y + (b.y - a.y) * smooth;
    entity.mass = a.mass + (b.mass - a.mass) * smooth;
    return;
  }
  const latest = history[history.length - 1];
  const extra = Math.min(Math.max(0, renderAt - latest.at) / 1000, 0.025);
  entity.x = latest.x + entity.vx * extra;
  entity.y = latest.y + entity.vy * extra;
  entity.mass = latest.mass;
}

function advanceVisuals(dt, now) {
  for (const cell of visualCells.values()) predictPlayerCell(cell, dt, now);
  resolveVisualSiblingCollisions(now);
  for (const entity of visualEjected.values()) interpolatePassive(entity, now);
  for (const entity of visualViruses.values()) interpolatePassive(entity, now);
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

function updateUi(now) {
  if (now - lastUiUpdate < UI_INTERVAL_MS || !snapshot) return;
  lastUiUpdate = now;
  scoreValue.textContent = Math.round(latestMass).toLocaleString();
  stats.textContent = `${latestCellCount} cell${latestCellCount === 1 ? '' : 's'} · ${Math.round(fps)} FPS · ${Math.round(rtt)} ms`;
  leaderboard.innerHTML = snapshot.leaderboard.map(entry =>
    `<li${entry.id === selfId ? ' class="self"' : ''}>${escapeHtml(entry.name)} <span>${entry.mass}</span></li>`
  ).join('');
}

function drawMinimap(now) {
  if (!snapshot || now - lastMinimapUpdate < MINIMAP_INTERVAL_MS) return;
  lastMinimapUpdate = now;
  const cssSize = Number(minimap.dataset.cssSize) || 160;
  const ratio = Number(minimap.dataset.ratio) || 1;
  minimapCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  minimapCtx.clearRect(0, 0, cssSize, cssSize);

  const miniBg = minimapCtx.createLinearGradient(0, 0, cssSize, cssSize);
  if (theme === 'light') {
    miniBg.addColorStop(0, 'rgba(255,255,255,.96)');
    miniBg.addColorStop(1, 'rgba(226,240,254,.94)');
  } else {
    miniBg.addColorStop(0, 'rgba(8,20,43,.94)');
    miniBg.addColorStop(1, 'rgba(3,8,20,.92)');
  }
  minimapCtx.fillStyle = miniBg;
  minimapCtx.fillRect(0, 0, cssSize, cssSize);
  minimapCtx.strokeStyle = theme === 'light' ? 'rgba(30,70,120,.14)' : 'rgba(102,247,255,.12)';
  minimapCtx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const p = cssSize * i / 5;
    minimapCtx.beginPath(); minimapCtx.moveTo(p, 0); minimapCtx.lineTo(p, cssSize); minimapCtx.stroke();
    minimapCtx.beginPath(); minimapCtx.moveTo(0, p); minimapCtx.lineTo(cssSize, p); minimapCtx.stroke();
  }

  const sx = cssSize / snapshot.world.width;
  const sy = cssSize / snapshot.world.height;
  for (const entry of snapshot.minimap || []) {
    const x = entry.x * sx;
    const y = entry.y * sy;
    const isSelf = entry.id === selfId;
    const dot = isSelf ? 5.5 : clamp(2.2 + Math.log10(Math.max(10, entry.mass)) * 0.7, 2.5, 4.3);
    minimapCtx.beginPath();
    minimapCtx.arc(x, y, dot, 0, Math.PI * 2);
    minimapCtx.fillStyle = entry.color || '#00e5ff';
    minimapCtx.fill();
    minimapCtx.strokeStyle = isSelf ? (theme === 'light' ? '#13233d' : '#ffffff') : colorAlpha(entry.color || '#00e5ff', .55);
    minimapCtx.lineWidth = isSelf ? 2 : 1;
    minimapCtx.stroke();
  }

  const viewportW = Math.min(snapshot.world.width, innerWidth / camera.zoom);
  const viewportH = Math.min(snapshot.world.height, innerHeight / camera.zoom);
  minimapCtx.strokeStyle = theme === 'light' ? 'rgba(20,50,90,.58)' : 'rgba(255,255,255,.65)';
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(
    clamp((camera.x - viewportW / 2) * sx, 0, cssSize),
    clamp((camera.y - viewportH / 2) * sy, 0, cssSize),
    viewportW * sx,
    viewportH * sy,
  );
}

function drawGrid(world) {
  const minorGap = 80;
  const majorGap = 400;
  const cx = innerWidth / 2 - camera.x * camera.zoom;
  const cy = innerHeight / 2 - camera.y * camera.zoom;
  ctx.save();

  const drawLines = (gap, stroke, width) => {
    const scaledGap = gap * camera.zoom;
    if (scaledGap < 12) return;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    const startX = ((cx % scaledGap) + scaledGap) % scaledGap;
    const startY = ((cy % scaledGap) + scaledGap) % scaledGap;
    ctx.beginPath();
    for (let x = startX; x < innerWidth; x += scaledGap) { ctx.moveTo(x, 0); ctx.lineTo(x, innerHeight); }
    for (let y = startY; y < innerHeight; y += scaledGap) { ctx.moveTo(0, y); ctx.lineTo(innerWidth, y); }
    ctx.stroke();
  };

  drawLines(minorGap, theme === 'light' ? 'rgba(41,91,137,.075)' : 'rgba(63,200,255,.07)', 1);
  drawLines(majorGap, theme === 'light' ? 'rgba(28,78,126,.115)' : 'rgba(89,219,255,.115)', 1.25);

  const point = toScreen(0, 0);
  ctx.strokeStyle = theme === 'light' ? 'rgba(20,91,161,.4)' : 'rgba(0,229,255,.46)';
  ctx.lineWidth = 3;
  ctx.strokeRect(point.x, point.y, world.width * camera.zoom, world.height * camera.zoom);
  ctx.restore();
}

function toScreen(x, y) {
  return {
    x: (x - camera.x) * camera.zoom + innerWidth / 2,
    y: (y - camera.y) * camera.zoom + innerHeight / 2,
  };
}

function isVisible(point, rr, padding = 20) {
  return point.x + rr + padding >= 0 && point.x - rr - padding <= innerWidth && point.y + rr + padding >= 0 && point.y - rr - padding <= innerHeight;
}

function drawPellet(pellet) {
  const point = toScreen(pellet.x, pellet.y);
  const rr = Math.max(2.4, 5.3 * camera.zoom);
  if (!isVisible(point, rr, 8)) return;

  ctx.beginPath();
  ctx.arc(point.x, point.y, rr * 1.65, 0, Math.PI * 2);
  ctx.fillStyle = colorAlpha(pellet.color, theme === 'light' ? .10 : .16);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(point.x, point.y, rr, 0, Math.PI * 2);
  ctx.fillStyle = pellet.color;
  ctx.fill();
  ctx.strokeStyle = mixColor(pellet.color, 'black', .22, .34);
  ctx.lineWidth = 1;
  ctx.stroke();

  if (rr > 3.4) {
    ctx.beginPath();
    ctx.arc(point.x - rr * .28, point.y - rr * .3, rr * .28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.58)';
    ctx.fill();
  }
}

function drawEjected(blob) {
  const point = toScreen(blob.x, blob.y);
  const rr = radius(blob.mass) * camera.zoom;
  if (!isVisible(point, rr)) return;

  ctx.beginPath();
  ctx.arc(point.x, point.y, rr * 1.08, 0, Math.PI * 2);
  ctx.fillStyle = mixColor(blob.color, 'black', .18, .38);
  ctx.fill();

  const grad = ctx.createRadialGradient(point.x - rr * .28, point.y - rr * .3, rr * .08, point.x, point.y, rr);
  grad.addColorStop(0, mixColor(blob.color, 'white', .42));
  grad.addColorStop(.58, blob.color);
  grad.addColorStop(1, mixColor(blob.color, 'black', .24));
  ctx.beginPath();
  ctx.arc(point.x, point.y, rr, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.48)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function drawVirus(virus, now) {
  const point = toScreen(virus.x, virus.y);
  const rr = radius(virus.mass) * camera.zoom;
  if (!isVisible(point, rr, 30)) return;
  const spikes = 28;
  const phase = (virus.id % 17) * 0.19 + now * 0.00006;

  ctx.save();
  ctx.shadowColor = theme === 'light' ? 'rgba(20,180,85,.24)' : 'rgba(45,255,119,.34)';
  ctx.shadowBlur = Math.min(18, rr * .24);
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const angle = phase + i * Math.PI / spikes;
    const spike = i % 2 === 0;
    const wave = 1 + Math.sin(i * 1.73 + virus.id) * .025;
    const r = rr * (spike ? 1.13 : .87) * wave;
    const x = point.x + Math.cos(angle) * r;
    const y = point.y + Math.sin(angle) * r;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
  const grad = ctx.createRadialGradient(point.x - rr * .28, point.y - rr * .34, rr * .08, point.x, point.y, rr * 1.08);
  grad.addColorStop(0, '#9dff8f');
  grad.addColorStop(.36, '#28ee70');
  grad.addColorStop(.78, '#08ad51');
  grad.addColorStop(1, '#05743b');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = theme === 'light' ? '#06713c' : '#baffc9';
  ctx.lineWidth = Math.max(1.5, rr * .045);
  ctx.stroke();

  ctx.clip();
  for (let i = 0; i < 6; i++) {
    const a = seededUnit(virus.id * 31 + i) * Math.PI * 2;
    const d = rr * (.18 + seededUnit(virus.id * 47 + i) * .46);
    const br = rr * (.055 + seededUnit(virus.id * 59 + i) * .045);
    ctx.beginPath();
    ctx.arc(point.x + Math.cos(a) * d, point.y + Math.sin(a) * d, br, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? 'rgba(1,86,44,.22)' : 'rgba(220,255,224,.24)';
    ctx.fill();
  }
  ctx.restore();

  const fed = Math.max(0, Math.min(7, Number(virus.fed) || 0));
  if (fed > 0 && rr > 18) {
    for (let i = 0; i < fed; i++) {
      const angle = -Math.PI / 2 + i * (Math.PI * 2 / 7);
      ctx.beginPath();
      ctx.arc(point.x + Math.cos(angle) * rr * .58, point.y + Math.sin(angle) * rr * .58, Math.max(1.5, rr * .035), 0, Math.PI * 2);
      ctx.fillStyle = '#f2ff55';
      ctx.fill();
    }
  }
}

function drawCellSurface(cell, point, rr, isSelf) {
  const color = cell.color || '#00e5ff';
  if (rr < 9) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isSelf ? 'rgba(255,255,255,.92)' : mixColor(color, 'black', .28, .72);
    ctx.lineWidth = isSelf ? 2 : 1.5;
    ctx.stroke();
    return;
  }

  ctx.save();
  ctx.shadowColor = theme === 'light' ? 'rgba(36,62,91,.20)' : 'rgba(0,0,0,.35)';
  ctx.shadowBlur = Math.min(17, rr * .16);
  ctx.shadowOffsetY = Math.min(5, rr * .05);

  const grad = ctx.createRadialGradient(
    point.x - rr * .30, point.y - rr * .34, Math.max(1, rr * .06),
    point.x + rr * .06, point.y + rr * .08, rr * 1.06,
  );
  grad.addColorStop(0, mixColor(color, 'white', .40));
  grad.addColorStop(.30, mixColor(color, 'white', .13));
  grad.addColorStop(.68, color);
  grad.addColorStop(1, mixColor(color, 'black', .34));

  ctx.beginPath();
  ctx.arc(point.x, point.y, rr, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.strokeStyle = mixColor(color, 'black', theme === 'light' ? .34 : .28, .82);
  ctx.lineWidth = Math.max(1.5, Math.min(4, rr * .055));
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(point.x, point.y, Math.max(1, rr - ctx.lineWidth * 1.25), 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.lineWidth = Math.max(1, rr * .025);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(point.x, point.y, rr * .96, 0, Math.PI * 2);
  ctx.clip();

  const highlight = ctx.createRadialGradient(
    point.x - rr * .34, point.y - rr * .40, 0,
    point.x - rr * .28, point.y - rr * .33, rr * .72,
  );
  highlight.addColorStop(0, 'rgba(255,255,255,.34)');
  highlight.addColorStop(.42, 'rgba(255,255,255,.10)');
  highlight.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = highlight;
  ctx.fillRect(point.x - rr, point.y - rr, rr * 2, rr * 2);

  if (rr > 24) {
    const detailCount = rr > 55 ? 4 : 2;
    for (let i = 0; i < detailCount; i++) {
      const angle = seededUnit(cell.id * 29 + i * 11) * Math.PI * 2;
      const distance = rr * (.18 + seededUnit(cell.id * 41 + i * 7) * .42);
      const size = rr * (.045 + seededUnit(cell.id * 53 + i * 13) * .035);
      ctx.beginPath();
      ctx.arc(point.x + Math.cos(angle) * distance, point.y + Math.sin(angle) * distance, size, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.085)' : 'rgba(0,0,0,.07)';
      ctx.fill();
    }
  }
  ctx.restore();

  if (isSelf) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, rr + Math.max(1.5, rr * .025), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.88)';
    ctx.lineWidth = Math.max(2, Math.min(3.5, rr * .045));
    ctx.shadowColor = colorAlpha(color, .55);
    ctx.shadowBlur = Math.min(12, rr * .11);
    ctx.stroke();
    ctx.restore();
  }
}

function drawCellLabel(cell, point, rr) {
  if (rr <= 18) return;
  const fontSize = Math.max(10, Math.min(24, rr * .31));
  const massSize = Math.max(9, Math.min(15, rr * .19));
  const yOffset = rr > 34 ? -6 : 0;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${fontSize}px system-ui,-apple-system,sans-serif`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2.5, fontSize * .18);
  ctx.strokeStyle = 'rgba(0,0,0,.38)';
  ctx.strokeText(cell.name, point.x, point.y + yOffset);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(cell.name, point.x, point.y + yOffset);

  if (rr > 34) {
    ctx.font = `750 ${massSize}px system-ui,-apple-system,sans-serif`;
    ctx.lineWidth = Math.max(2, massSize * .17);
    ctx.strokeStyle = 'rgba(0,0,0,.34)';
    ctx.strokeText(String(Math.round(cell.mass)), point.x, point.y + 14);
    ctx.fillStyle = 'rgba(255,255,255,.90)';
    ctx.fillText(String(Math.round(cell.mass)), point.x, point.y + 14);
  }
  ctx.restore();
}

function drawCell(cell) {
  const r = radius(cell.mass);
  const point = toScreen(cell.x, cell.y);
  const rr = r * camera.zoom;
  if (!isVisible(point, rr, 24)) return;
  const isSelf = cell.ownerId === selfId;
  drawCellSurface(cell, point, rr, isSelf);
  drawCellLabel(cell, point, rr);
}

function draw() {
  const now = performance.now();
  const frameMs = clamp(now - lastFrame, 1, 50);
  const dt = frameMs / 1000;
  fps = fps * 0.92 + (1000 / frameMs) * 0.08;
  lastFrame = now;

  advanceVisuals(dt, now);
  updateCamera(dt);
  updateUi(now);
  drawMinimap(now);

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = backgroundGradient || (theme === 'light' ? '#eef6ff' : '#030814');
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  if (snapshot) {
    drawGrid(snapshot.world);
    for (const pellet of snapshot.pellets || []) drawPellet(pellet);
    for (const blob of visualEjected.values()) drawEjected(blob);
    for (const virus of visualViruses.values()) drawVirus(virus, now);

    const ordered = Array.from(visualCells.values()).sort((a, b) => b.mass - a.mass);
    for (const cell of ordered) drawCell(cell);
  }

  if (vignetteGradient) {
    ctx.fillStyle = vignetteGradient;
    ctx.fillRect(0, 0, innerWidth, innerHeight);
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
