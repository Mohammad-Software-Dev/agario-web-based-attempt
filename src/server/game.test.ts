import { describe, expect, it, vi } from 'vitest';
import { Game } from './game.js';
import { GAME } from '../shared/constants.js';

const makeGame = () => new Game({ worldWidth: 2000, worldHeight: 2000, foodCount: 0, virusCount: 0, botCount: 0, tickRate: 30, snapshotRate: 15 });

describe('Game mechanics', () => {
  it('splits an eligible cell into two while preserving mass', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.cells[0]!.mass = 100; p.target={x:p.cells[0]!.x+500,y:p.cells[0]!.y};
    const before = game.totalMass(p); game.split(p, 1000);
    expect(p.cells).toHaveLength(2); expect(game.totalMass(p)).toBeCloseTo(before, 8);
  });
  it('will not exceed the 16 cell cap', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.cells[0]!.mass = 10000;
    let now=1000; for(let i=0;i<8;i++){ game.split(p, now); now += GAME.splitCooldownMs+1; }
    expect(p.cells.length).toBeLessThanOrEqual(GAME.maxCellsPerPlayer);
  });
  it('ejection spends more mass than it creates', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.cells[0]!.mass=100; p.target={x:p.cells[0]!.x+100,y:p.cells[0]!.y};
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

  it('respawns dead players', () => {
    const game = makeGame(); const p = game.addPlayer('A'); p.cells=[]; p.alive=false; game.respawn(p);
    expect(p.alive).toBe(true); expect(p.cells).toHaveLength(1);
  });
});
