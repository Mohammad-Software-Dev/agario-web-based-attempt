import { describe, expect, it } from 'vitest';
import { Game } from './game.js';
import { GAME } from '../shared/constants.js';

const makeGame = () => new Game({ worldWidth: 2000, worldHeight: 2000, foodCount: 0, virusCount: 0, botCount: 0, tickRate: 30, snapshotRate: 30 });

function expectNoSiblingOverlap(cells: Array<{ x: number; y: number; mass: number }>, tolerance = 1.1) {
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i]!;
      const b = cells[j]!;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const minimum = Math.sqrt(a.mass) * 4 + Math.sqrt(b.mass) * 4;
      expect(distance).toBeGreaterThanOrEqual(minimum - tolerance);
    }
  }
}

describe('Game mechanics', () => {
  it('splits an eligible cell into two while preserving mass', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.cells[0]!.mass = 100; p.target = { x: p.cells[0]!.x + 500, y: p.cells[0]!.y };
    const before = game.totalMass(p); game.split(p, 1000);
    expect(p.cells).toHaveLength(2); expect(game.totalMass(p)).toBeCloseTo(before, 8);
  });

  it('creates split siblings already separated and keeps them separated while steering together', () => {
    const game = makeGame(); const p = game.addPlayer('A'); const source = p.cells[0]!;
    source.mass = 100; p.target = { x: source.x + 500, y: source.y };
    game.split(p, 1000);
    expect(p.cells).toHaveLength(2);
    expectNoSiblingOverlap(p.cells, 0.2);

    for (let tick = 1; tick <= 120; tick++) {
      const center = game.getCenter(p)!;
      p.target = { x: center.x, y: center.y };
      game.tick(1 / 30, 1000 + tick * (1000 / 30));
      expectNoSiblingOverlap(p.cells);
    }
  });

  it('fully separates a high-count virus pop instead of leaving stacked cells', () => {
    const game = makeGame(); const p = game.addPlayer('A'); const source = p.cells[0]!;
    source.mass = 500;
    source.x = 1000;
    source.y = 1000;
    game.viruses.set(9999, { id: 9999, x: 1000, y: 1000, mass: GAME.virusMass, fed: 0, vx: 0, vy: 0 });

    game.tick(1 / 30, 2000);
    expect(p.cells.length).toBeGreaterThanOrEqual(8);
    expectNoSiblingOverlap(p.cells);

    for (let tick = 1; tick <= 30; tick++) {
      const center = game.getCenter(p)!;
      p.target = { x: center.x, y: center.y };
      game.tick(1 / 30, 2000 + tick * (1000 / 30));
      expectNoSiblingOverlap(p.cells);
    }
  });

  it('will not exceed the 16 cell cap', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.cells[0]!.mass = 10000;
    let now = 1000; for (let i = 0; i < 8; i++) { game.split(p, now); now += GAME.splitCooldownMs + 1; }
    expect(p.cells.length).toBeLessThanOrEqual(GAME.maxCellsPerPlayer);
  });

  it('ejection spends more mass than it creates', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.cells[0]!.mass = 100; p.target = { x: p.cells[0]!.x + 100, y: p.cells[0]!.y };
    game.eject(p, 1000); expect(p.cells[0]!.mass).toBe(82); expect([...game.ejected.values()][0]!.mass).toBe(13);
  });

  it('keeps cells inside the world after their mass changes', () => {
    const game = makeGame(); const p = game.addPlayer('A'); const c = p.cells[0]!;
    c.x = 1990; c.y = 1990; c.mass = 225;
    game.tick(0, 1000);
    const r = Math.sqrt(c.mass) * 4;
    expect(c.x).toBeLessThanOrEqual(2000 - r);
    expect(c.y).toBeLessThanOrEqual(2000 - r);
  });

  it('includes movement, merge timing and compact minimap data in snapshots', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.target = { x: 1200, y: 800 };
    const state = game.snapshotFor(p);
    expect(state.players[0]!.target).toEqual({ x: 1200, y: 800 });
    expect(state.players[0]!.cells[0]).toMatchObject({ vx: 0, vy: 0, boostMs: 0, mergeMs: 0 });
    expect(state.minimap.some(entry => entry.id === p.id)).toBe(true);
  });

  it('respawns dead players', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.cells = []; p.alive = false; game.respawn(p);
    expect(p.alive).toBe(true); expect(p.cells).toHaveLength(1);
  });
});
