import type { Vec2 } from '../shared/math.js';

export interface SocketLike {
  readyState: number;
  send(data: string): void;
}

export interface Cell extends Vec2 {
  id: number;
  ownerId: number;
  mass: number;
  vx: number;
  vy: number;
  boostUntil: number;
  canMergeAt: number;
}
export interface Pellet extends Vec2 { id: number; mass: number; color: string }
export interface Virus extends Vec2 { id: number; mass: number; fed: number; vx: number; vy: number }
export interface EjectedMass extends Vec2 { id: number; ownerId: number; mass: number; vx: number; vy: number; bornAt: number; color: string }
export interface Player {
  id: number;
  name: string;
  color: string;
  cells: Cell[];
  target: Vec2;
  ws?: SocketLike;
  isBot: boolean;
  alive: boolean;
  lastSplitAt: number;
  lastEjectAt: number;
  lastInputAt: number;
  lastBotThinkAt: number;
  inputCountWindow: number;
  inputWindowStartedAt: number;
}
export interface GameConfig {
  worldWidth: number;
  worldHeight: number;
  foodCount: number;
  virusCount: number;
  botCount: number;
  tickRate: number;
  snapshotRate: number;
}
