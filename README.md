# agario-web-based-attempt / Cell Arena

An original, production-oriented browser multiplayer game inspired by the **eat → grow → split** cell-arena genre. It does **not** copy Agar.io source code, network protocol, branding, or assets.

## What is included

- Authoritative Node.js/TypeScript game server
- WebSocket real-time multiplayer (`ws`)
- HTML5 Canvas renderer with responsive camera and mobile controls
- Smoothed 60 FPS client rendering with short extrapolation between authoritative snapshots
- Server-controlled food, cells, viruses, collisions, mass decay, splitting, merging, ejected mass, virus feeding and shooting
- Autonomous bots with threat avoidance, prey pursuit, food seeking and split attacks
- Top-10 leaderboard and player stats
- Rate limiting, input validation, WebSocket heartbeat, max payload, optional origin allow-list
- Health endpoint (`/healthz`)
- Unit tests, strict TypeScript build, Docker image, Compose and GitHub Actions CI

## Play locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 in two browser windows to test multiplayer. Bots are enabled by default.

Production build:

```bash
npm run check
npm run build
npm start
```

Docker:

```bash
docker compose up --build
```

## Controls

- **Mouse / touch:** move
- **Space:** split eligible cells toward the pointer, up to 16 cells
- **W:** eject mass toward the pointer

## Architecture

The server is authoritative: clients only send steering/actions. At 30 simulation ticks per second the server advances movement and resolves collisions; at 20 snapshots per second each human receives an area-of-interest state around their mass-weighted camera center. The browser renders at the display frame rate, smoothing and briefly extrapolating entity motion between snapshots while continuously smoothing the camera.

This design deliberately keeps combat decisions on the server, making client-side position/mass cheats much harder than a client-authoritative implementation while avoiding the visual stepping of rendering raw snapshots directly.

## Configuration

Copy `.env.example` values into your deployment environment. Important variables:

| Variable | Default | Meaning |
|---|---:|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `BOT_COUNT` | `18` | Autonomous players |
| `WORLD_WIDTH` / `WORLD_HEIGHT` | `7000` | Arena dimensions |
| `FOOD_COUNT` | `900` | Pellet target count |
| `VIRUS_COUNT` | `28` | Virus target count |
| `TICK_RATE` | `30` | Server simulation Hz |
| `SNAPSHOT_RATE` | `20` | Client state Hz |
| `ALLOWED_ORIGINS` | empty | Optional comma-separated WebSocket origin allow-list |

## Production notes

Run a single arena per Node process. For scale-out, route players to arena instances at matchmaking time rather than trying to share one physics world across processes. Terminate TLS at a reverse proxy/load balancer that supports WebSocket upgrade, apply connection/IP limits there, and collect process/health metrics. The in-memory arena intentionally has no database dependency.

The browser caps its internal render pixel ratio (lower on coarse/mobile pointers) so high-DPI displays do not accidentally render the arena at 3×–4× native resolution and waste GPU time.

## Gameplay model

The mechanics are genre-faithful rather than protocol-identical: mass determines radius and speed; sufficiently larger cells eat smaller cells; splitting launches half-mass children; cells merge after a mass-dependent cooldown; ejection loses more mass than it creates; viruses split sufficiently large cells; feeding a virus can shoot a new virus.

## Trademark / affiliation

“Agar.io” is a trademark/name associated with Miniclip and its game. This project is an independent educational implementation and is not affiliated with, endorsed by, or sourced from Miniclip/Agar.io. Use your own name and artwork for any public/commercial deployment.
