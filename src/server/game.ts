import { COLORS, GAME } from '../shared/constants.js';
import { clamp, distanceSq, normalize, radiusFromMass, randomBetween, speedFromMass, type Vec2 } from '../shared/math.js';
import type { Cell, EjectedMass, GameConfig, Pellet, Player, Virus } from './types.js';

const BOT_NAMES = ['Orbit', 'Pixel', 'Nova', 'Mochi', 'Glitch', 'Pico', 'Vega', 'Comet', 'Byte', 'Echo', 'Mango', 'Lumen', 'Astra', 'Kiwi', 'Zig', 'Nori'];

export class Game {
  readonly players = new Map<number, Player>();
  readonly pellets = new Map<number, Pellet>();
  readonly viruses = new Map<number, Virus>();
  readonly ejected = new Map<number, EjectedMass>();
  private idCounter = 1;

  constructor(readonly config: GameConfig) {
    for (let i = 0; i < config.foodCount; i++) this.spawnPellet();
    for (let i = 0; i < config.virusCount; i++) this.spawnVirus();
    for (let i = 0; i < config.botCount; i++) this.addBot(i);
  }

  nextId() { return this.idCounter++; }

  addPlayer(name: string, isBot = false): Player {
    const id = this.nextId();
    const player: Player = {
      id,
      name,
      color: COLORS[id % COLORS.length] ?? '#4cc9f0',
      cells: [],
      target: { x: this.config.worldWidth / 2, y: this.config.worldHeight / 2 },
      isBot,
      alive: true,
      lastSplitAt: 0,
      lastEjectAt: 0,
      lastInputAt: Date.now(),
      lastBotThinkAt: 0,
      inputCountWindow: 0,
      inputWindowStartedAt: Date.now(),
    };
    this.players.set(id, player);
    this.respawn(player);
    return player;
  }

  addBot(index = 0) {
    const base = BOT_NAMES[index % BOT_NAMES.length] ?? 'Bot';
    return this.addPlayer(`${base} · BOT`, true);
  }

  removePlayer(id: number) { this.players.delete(id); }

  respawn(player: Player) {
    const safe = this.findSpawnPoint();
    player.cells = [this.createCell(player.id, safe.x, safe.y, GAME.startMass)];
    player.target = { ...safe };
    player.alive = true;
  }

  private findSpawnPoint(): Vec2 {
    for (let tries = 0; tries < 25; tries++) {
      const p = { x: randomBetween(200, this.config.worldWidth - 200), y: randomBetween(200, this.config.worldHeight - 200) };
      const dangerous = [...this.players.values()].flatMap(v => v.cells).some(c => c.mass > 150 && distanceSq(c, p) < 600 * 600);
      if (!dangerous) return p;
    }
    return { x: randomBetween(100, this.config.worldWidth - 100), y: randomBetween(100, this.config.worldHeight - 100) };
  }

  private createCell(ownerId: number, x: number, y: number, mass: number): Cell {
    const r = radiusFromMass(mass);
    return {
      id: this.nextId(), ownerId,
      x: clamp(x, r + GAME.worldMargin, this.config.worldWidth - r - GAME.worldMargin),
      y: clamp(y, r + GAME.worldMargin, this.config.worldHeight - r - GAME.worldMargin),
      mass, vx: 0, vy: 0, boostUntil: 0, canMergeAt: 0,
    };
  }

  private spawnPellet() {
    const id = this.nextId();
    this.pellets.set(id, {
      id,
      x: randomBetween(20, this.config.worldWidth - 20),
      y: randomBetween(20, this.config.worldHeight - 20),
      mass: GAME.foodMass,
      color: COLORS[id % COLORS.length] ?? '#fff',
    });
  }

  private spawnVirus(x?: number, y?: number, vx = 0, vy = 0) {
    const id = this.nextId();
    this.viruses.set(id, {
      id,
      x: x ?? randomBetween(250, this.config.worldWidth - 250),
      y: y ?? randomBetween(250, this.config.worldHeight - 250),
      mass: GAME.virusMass,
      fed: 0,
      vx,
      vy,
    });
  }

  setTarget(player: Player, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    player.target.x = clamp(x, 0, this.config.worldWidth);
    player.target.y = clamp(y, 0, this.config.worldHeight);
    player.lastInputAt = Date.now();
  }

  split(player: Player, now = Date.now()) {
    if (!player.alive || now - player.lastSplitAt < GAME.splitCooldownMs) return;
    let slots = GAME.maxCellsPerPlayer - player.cells.length;
    if (slots <= 0) return;
    const original = [...player.cells].sort((a, b) => b.mass - a.mass);
    const additions: Cell[] = [];
    for (const cell of original) {
      if (slots <= 0 || cell.mass < GAME.minSplitMass) continue;
      let dir = normalize({ x: player.target.x - cell.x, y: player.target.y - cell.y });
      if (Math.abs(dir.x) + Math.abs(dir.y) < 0.0001) dir = { x: 1, y: 0 };
      const half = cell.mass / 2;
      cell.mass = half;
      cell.canMergeAt = now + GAME.mergeBaseMs + half * GAME.mergeMassFactorMs;
      const r = radiusFromMass(half);
      // Equal split circles need 2r center distance just to be tangent. Spawn the
      // launched half slightly beyond tangent so there is never a visible overlap.
      const child = this.createCell(player.id, cell.x + dir.x * r * 2.05, cell.y + dir.y * r * 2.05, half);
      child.vx = dir.x * GAME.splitBoostSpeed;
      child.vy = dir.y * GAME.splitBoostSpeed;
      child.boostUntil = now + GAME.splitBoostMs;
      child.canMergeAt = cell.canMergeAt;
      additions.push(child);
      slots--;
    }
    player.cells.push(...additions);
    player.lastSplitAt = now;
    this.resolveOwnCellCollisions(now);
  }

  eject(player: Player, now = Date.now()) {
    if (!player.alive || now - player.lastEjectAt < GAME.ejectCooldownMs) return;
    for (const cell of player.cells) {
      if (cell.mass < GAME.minEjectMass) continue;
      const dir = normalize({ x: player.target.x - cell.x, y: player.target.y - cell.y });
      cell.mass = Math.max(10, cell.mass - GAME.ejectCost);
      const r = radiusFromMass(cell.mass);
      const id = this.nextId();
      this.ejected.set(id, {
        id, ownerId: player.id,
        x: cell.x + dir.x * (r + 12), y: cell.y + dir.y * (r + 12),
        mass: GAME.ejectMass, vx: dir.x * GAME.ejectSpeed, vy: dir.y * GAME.ejectSpeed,
        bornAt: now, color: player.color,
      });
    }
    player.lastEjectAt = now;
  }

  tick(dt: number, now = Date.now()) {
    this.updateBots(now);
    this.moveDynamic(dt, now);
    this.resolveOwnCellCollisions(now);
    this.consumePellets();
    this.consumeEjected();
    this.feedViruses();
    this.consumeViruses(now);
    this.consumePlayers();
    // Growth, virus pops and eating can change radii inside this tick, so enforce
    // the non-overlap constraint again before merge-ready cells are combined.
    this.resolveOwnCellCollisions(now);
    this.mergeOwnCells(now);
    this.decayMass(dt);
    this.clampCellsToWorld();
    this.maintainPopulation();
  }

  private moveDynamic(dt: number, now: number) {
    for (const player of this.players.values()) {
      for (const cell of player.cells) {
        const r = radiusFromMass(cell.mass);
        if (now < cell.boostUntil) {
          cell.x += cell.vx * dt;
          cell.y += cell.vy * dt;
          cell.vx *= Math.pow(0.02, dt);
          cell.vy *= Math.pow(0.02, dt);
        } else {
          const toTarget = { x: player.target.x - cell.x, y: player.target.y - cell.y };
          const dir = normalize(toTarget);
          const speed = speedFromMass(cell.mass, GAME.baseSpeed);
          const distance = Math.hypot(toTarget.x, toTarget.y);
          const throttle = clamp(distance / Math.max(r, 60), 0, 1);
          cell.x += dir.x * speed * throttle * dt;
          cell.y += dir.y * speed * throttle * dt;
        }
        cell.x = clamp(cell.x, r + GAME.worldMargin, this.config.worldWidth - r - GAME.worldMargin);
        cell.y = clamp(cell.y, r + GAME.worldMargin, this.config.worldHeight - r - GAME.worldMargin);
      }
    }
    for (const blob of this.ejected.values()) {
      blob.x += blob.vx * dt; blob.y += blob.vy * dt;
      blob.vx *= Math.pow(0.05, dt); blob.vy *= Math.pow(0.05, dt);
      blob.x = clamp(blob.x, 8, this.config.worldWidth - 8);
      blob.y = clamp(blob.y, 8, this.config.worldHeight - 8);
    }
    for (const virus of this.viruses.values()) {
      virus.x += virus.vx * dt; virus.y += virus.vy * dt;
      virus.vx *= Math.pow(0.08, dt); virus.vy *= Math.pow(0.08, dt);
      if (virus.x < 45 || virus.x > this.config.worldWidth - 45) virus.vx *= -0.7;
      if (virus.y < 45 || virus.y > this.config.worldHeight - 45) virus.vy *= -0.7;
      virus.x = clamp(virus.x, 40, this.config.worldWidth - 40);
      virus.y = clamp(virus.y, 40, this.config.worldHeight - 40);
    }
  }

  /**
   * Enforce a hard non-overlap constraint between a player's own cells while
   * either cell is still on merge cooldown. This is a positional circle solver:
   * penetration = rA + rB + padding - centerDistance.
   *
   * Multiple Gauss-Seidel passes are intentional. A single pair pass is not
   * sufficient for virus pops (many circles born close together), and clamping a
   * cell against a world wall can leave residual penetration that a later pass
   * must transfer into the unconstrained sibling.
   */
  private resolveOwnCellCollisions(now: number) {
    const padding = 0.75;
    const iterations = 10;

    for (const player of this.players.values()) {
      const cells = player.cells;
      if (cells.length < 2) continue;

      for (let pass = 0; pass < iterations; pass++) {
        let corrected = false;
        for (let i = 0; i < cells.length; i++) {
          const a = cells[i]; if (!a) continue;
          for (let j = i + 1; j < cells.length; j++) {
            const b = cells[j]; if (!b) continue;
            // Once both timers have elapsed, overlap is allowed so the merge rule
            // can draw the pieces into one another and recombine them.
            if (now >= a.canMergeAt && now >= b.canMergeAt) continue;

            const ar = radiusFromMass(a.mass);
            const br = radiusFromMass(b.mass);
            const minDistance = ar + br + padding;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let distance = Math.hypot(dx, dy);
            if (distance >= minDistance) continue;

            let nx: number;
            let ny: number;
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
            const moveA = overlap * (br / totalRadius);
            const moveB = overlap * (ar / totalRadius);
            a.x -= nx * moveA;
            a.y -= ny * moveA;
            b.x += nx * moveB;
            b.y += ny * moveB;

            a.x = clamp(a.x, ar + GAME.worldMargin, this.config.worldWidth - ar - GAME.worldMargin);
            a.y = clamp(a.y, ar + GAME.worldMargin, this.config.worldHeight - ar - GAME.worldMargin);
            b.x = clamp(b.x, br + GAME.worldMargin, this.config.worldWidth - br - GAME.worldMargin);
            b.y = clamp(b.y, br + GAME.worldMargin, this.config.worldHeight - br - GAME.worldMargin);
            corrected = true;
          }
        }
        if (!corrected) break;
      }
    }
  }

  private consumePellets() {
    for (const player of this.players.values()) for (const cell of player.cells) {
      const r = radiusFromMass(cell.mass);
      for (const pellet of this.pellets.values()) {
        if (distanceSq(cell, pellet) <= r * r) {
          cell.mass = Math.min(GAME.maxCellMass, cell.mass + pellet.mass);
          this.pellets.delete(pellet.id); this.spawnPellet();
        }
      }
    }
  }

  private consumeEjected() {
    for (const player of this.players.values()) for (const cell of player.cells) {
      const r = radiusFromMass(cell.mass);
      for (const blob of this.ejected.values()) {
        if (blob.ownerId === player.id && Date.now() - blob.bornAt < 600) continue;
        if (cell.mass > blob.mass * 1.05 && distanceSq(cell, blob) <= r * r) {
          cell.mass = Math.min(GAME.maxCellMass, cell.mass + blob.mass);
          this.ejected.delete(blob.id);
        }
      }
    }
  }

  private feedViruses() {
    for (const virus of this.viruses.values()) {
      const vr = radiusFromMass(virus.mass);
      for (const blob of this.ejected.values()) {
        if (distanceSq(virus, blob) <= (vr + 8) ** 2) {
          virus.fed++;
          virus.mass += blob.mass * 0.35;
          const dir = normalize({ x: blob.vx, y: blob.vy });
          this.ejected.delete(blob.id);
          if (virus.fed >= GAME.virusFeedThreshold) {
            virus.fed = 0; virus.mass = GAME.virusMass;
            this.spawnVirus(virus.x + dir.x * 60, virus.y + dir.y * 60, dir.x * 520, dir.y * 520);
          }
        }
      }
    }
  }

  private consumeViruses(now: number) {
    for (const player of this.players.values()) {
      for (const cell of [...player.cells]) {
        const r = radiusFromMass(cell.mass);
        for (const virus of this.viruses.values()) {
          const vr = radiusFromMass(virus.mass);
          if (cell.mass >= virus.mass * 1.32 && distanceSq(cell, virus) <= Math.max(1, r - vr * 0.35) ** 2) {
            cell.mass = Math.min(GAME.maxCellMass, cell.mass + virus.mass);
            this.viruses.delete(virus.id);
            this.popCell(player, cell, now);
            this.spawnVirus();
            break;
          }
        }
      }
    }
  }

  private popCell(player: Player, cell: Cell, now: number) {
    const available = GAME.maxCellsPerPlayer - player.cells.length;
    if (available <= 0) return;
    const count = Math.min(available + 1, Math.max(4, Math.min(12, Math.floor(cell.mass / 30))));
    if (count <= 1) return;
    const each = cell.mass / count;
    cell.mass = each;
    cell.canMergeAt = now + GAME.mergeBaseMs + each * GAME.mergeMassFactorMs;
    const r = radiusFromMass(each);
    const children = count - 1;
    // Pack virus-pop children on a ring that is large enough for neighboring
    // equal-radius circles to start non-overlapping, while also clearing the
    // original center cell. The rigid solver handles walls and any residuals.
    const ringRadius = Math.max(r * 2.1, (r + 0.5) / Math.max(0.08, Math.sin(Math.PI / Math.max(2, children))));
    const phase = Math.random() * Math.PI * 2;
    for (let i = 0; i < children; i++) {
      const angle = phase + (Math.PI * 2 * i) / children;
      const child = this.createCell(player.id, cell.x + Math.cos(angle) * ringRadius, cell.y + Math.sin(angle) * ringRadius, each);
      child.vx = Math.cos(angle) * GAME.splitBoostSpeed * 0.75;
      child.vy = Math.sin(angle) * GAME.splitBoostSpeed * 0.75;
      child.boostUntil = now + GAME.splitBoostMs * 0.8;
      child.canMergeAt = cell.canMergeAt;
      player.cells.push(child);
    }
    this.resolveOwnCellCollisions(now);
  }

  private consumePlayers() {
    type CellRef = { player: Player; cell: Cell };
    const all: CellRef[] = [...this.players.values()].flatMap(p => p.cells.map(c => ({ player: p, cell: c })));
    const eaten = new Set<number>();
    for (let i = 0; i < all.length; i++) {
      const a = all[i]; if (!a || eaten.has(a.cell.id)) continue;
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j]; if (!b || eaten.has(b.cell.id) || a.player.id === b.player.id) continue;
        const eater: CellRef = a.cell.mass >= b.cell.mass ? a : b;
        const prey: CellRef = eater === a ? b : a;
        const ratio = eater.cell.mass / Math.max(1, prey.cell.mass);
        const required = eater.player.cells.length > 1 ? GAME.splitEatRatio : GAME.eatRatio;
        if (ratio < required) continue;
        const er = radiusFromMass(eater.cell.mass), pr = radiusFromMass(prey.cell.mass);
        if (distanceSq(eater.cell, prey.cell) < Math.max(2, er - pr * 0.28) ** 2) {
          eater.cell.mass = Math.min(GAME.maxCellMass, eater.cell.mass + prey.cell.mass);
          eaten.add(prey.cell.id);
          if (prey === a) break;
        }
      }
    }
    if (!eaten.size) return;
    for (const player of this.players.values()) {
      player.cells = player.cells.filter(c => !eaten.has(c.id));
      if (!player.cells.length) {
        player.alive = false;
        if (player.isBot) this.respawn(player);
      }
    }
  }

  private mergeOwnCells(now: number) {
    for (const player of this.players.values()) {
      let changed = true;
      while (changed) {
        changed = false;
        outer: for (let i = 0; i < player.cells.length; i++) {
          const a = player.cells[i]; if (!a || now < a.canMergeAt) continue;
          for (let j = i + 1; j < player.cells.length; j++) {
            const b = player.cells[j]; if (!b || now < b.canMergeAt) continue;
            const threshold = Math.max(radiusFromMass(a.mass), radiusFromMass(b.mass)) * 0.55;
            if (distanceSq(a, b) <= threshold * threshold) {
              const total = a.mass + b.mass;
              a.x = (a.x * a.mass + b.x * b.mass) / total;
              a.y = (a.y * a.mass + b.y * b.mass) / total;
              a.mass = Math.min(GAME.maxCellMass, total);
              player.cells.splice(j, 1);
              changed = true;
              break outer;
            }
          }
        }
      }
    }
  }

  private decayMass(dt: number) {
    for (const player of this.players.values()) for (const cell of player.cells) {
      if (cell.mass > 100) cell.mass = Math.max(10, cell.mass * (1 - GAME.massDecayPerSecond * dt));
    }
  }

  private clampCellsToWorld() {
    for (const player of this.players.values()) for (const cell of player.cells) {
      const r = radiusFromMass(cell.mass);
      cell.x = clamp(cell.x, r + GAME.worldMargin, this.config.worldWidth - r - GAME.worldMargin);
      cell.y = clamp(cell.y, r + GAME.worldMargin, this.config.worldHeight - r - GAME.worldMargin);
    }
  }

  private maintainPopulation() {
    while (this.pellets.size < this.config.foodCount) this.spawnPellet();
    while (this.viruses.size < this.config.virusCount) this.spawnVirus();
  }

  private updateBots(now: number) {
    for (const bot of this.players.values()) {
      if (!bot.isBot || !bot.alive || now - bot.lastBotThinkAt < GAME.botThinkMs) continue;
      bot.lastBotThinkAt = now;
      const anchor = this.getCenter(bot); if (!anchor) continue;
      const totalMass = this.totalMass(bot);
      let threat: Cell | undefined;
      let threatD = Infinity;
      let prey: Cell | undefined;
      let preyD = Infinity;
      for (const other of this.players.values()) {
        if (other.id === bot.id) continue;
        for (const c of other.cells) {
          const d = distanceSq(anchor, c);
          if (c.mass > totalMass * 1.15 && d < threatD) { threat = c; threatD = d; }
          if (totalMass > c.mass * 1.5 && d < preyD) { prey = c; preyD = d; }
        }
      }
      if (threat && threatD < 720 * 720) {
        const away = normalize({ x: anchor.x - threat.x, y: anchor.y - threat.y });
        bot.target = { x: clamp(anchor.x + away.x * 1200, 0, this.config.worldWidth), y: clamp(anchor.y + away.y * 1200, 0, this.config.worldHeight) };
        if (threatD < 260 * 260 && bot.cells.length < 6 && totalMass > 90) this.split(bot, now);
        continue;
      }
      if (prey && preyD < 1000 * 1000) {
        bot.target = { x: prey.x, y: prey.y };
        const biggest = Math.max(...bot.cells.map(c => c.mass));
        if (preyD < 420 * 420 && biggest > prey.mass * 2.7 && bot.cells.length < GAME.maxCellsPerPlayer) this.split(bot, now);
        continue;
      }
      let food: Pellet | undefined; let foodD = Infinity;
      for (const p of this.pellets.values()) {
        const d = distanceSq(anchor, p);
        if (d < foodD) { food = p; foodD = d; }
      }
      if (food) bot.target = { x: food.x, y: food.y };
      if (Math.random() < 0.005 && totalMass > 120) this.split(bot, now);
    }
  }

  totalMass(player: Player) { return player.cells.reduce((sum, c) => sum + c.mass, 0); }

  getCenter(player: Player): Vec2 | null {
    const total = this.totalMass(player); if (!total) return null;
    return {
      x: player.cells.reduce((s, c) => s + c.x * c.mass, 0) / total,
      y: player.cells.reduce((s, c) => s + c.y * c.mass, 0) / total,
    };
  }

  snapshotFor(player: Player) {
    const center = this.getCenter(player) ?? player.target;
    const totalMass = Math.max(GAME.startMass, this.totalMass(player));
    const range = GAME.snapshotRadiusBase + Math.sqrt(totalMass) * 18;
    const inRange = (p: Vec2) => Math.abs(p.x - center.x) <= range && Math.abs(p.y - center.y) <= range;
    const now = Date.now();
    const leaderboard = [...this.players.values()]
      .filter(p => p.alive)
      .map(p => ({ id: p.id, name: p.name, mass: Math.round(this.totalMass(p)), bot: p.isBot }))
      .sort((a, b) => b.mass - a.mass)
      .slice(0, 10);
    const minimap = [...this.players.values()]
      .filter(p => p.alive)
      .flatMap(p => {
        const c = this.getCenter(p);
        return c ? [{ id: p.id, x: Math.round(c.x), y: Math.round(c.y), mass: Math.round(this.totalMass(p)), color: p.color, bot: p.isBot }] : [];
      });

    return {
      type: 'snapshot',
      now,
      selfId: player.id,
      world: { width: this.config.worldWidth, height: this.config.worldHeight },
      players: [...this.players.values()]
        .filter(p => p.alive && p.cells.some(inRange))
        .map(p => ({
          id: p.id,
          name: p.name,
          color: p.color,
          bot: p.isBot,
          target: { x: Math.round(p.target.x * 10) / 10, y: Math.round(p.target.y * 10) / 10 },
          cells: p.cells.filter(inRange).map(c => ({
            id: c.id,
            x: Math.round(c.x * 10) / 10,
            y: Math.round(c.y * 10) / 10,
            mass: Math.round(c.mass * 10) / 10,
            vx: Math.round(c.vx * 10) / 10,
            vy: Math.round(c.vy * 10) / 10,
            boostMs: Math.max(0, c.boostUntil - now),
            mergeMs: Math.max(0, c.canMergeAt - now),
          })),
        })),
      pellets: [...this.pellets.values()].filter(inRange),
      viruses: [...this.viruses.values()].filter(inRange).map(v => ({ id: v.id, x: v.x, y: v.y, mass: v.mass, fed: v.fed })),
      ejected: [...this.ejected.values()].filter(inRange).map(e => ({ id: e.id, x: e.x, y: e.y, mass: e.mass, color: e.color })),
      minimap,
      leaderboard,
    };
  }
}
