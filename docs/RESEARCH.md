# Gameplay research notes

This project is an original implementation informed by public descriptions of Agar.io-style mechanics and by common real-time multiplayer architecture patterns. No game source code, private protocol, art, or proprietary assets were copied.

## Mechanics used as reference points

- Cells steer toward the pointer; larger cells move more slowly.
- Cells can split toward the pointer and are limited to 16 pieces.
- Ejecting mass costs more than the ejected pellet contains.
- Viruses punish sufficiently large cells by splitting them into many pieces.
- Viruses can be fed with ejected mass and can create/launch another virus.
- Leaderboards rank players by total mass.
- FFA-style play allows any sufficiently larger player to consume another.

The exact tuning in this repository is intentionally its own implementation rather than an attempt to duplicate a private production server.

## Architecture conclusions

Public Agar.io clone projects consistently use an authoritative or mostly authoritative game server, WebSockets/Socket.IO for continuous state exchange, and HTML5 Canvas for browser rendering. More advanced implementations discuss client-side prediction and reconciliation, but this project favors server authority plus smooth camera rendering to reduce cheat surface and complexity.

## Sources consulted

- Miniclip support: https://support.miniclip.com/hc/en-us/articles/4404685562641-How-to-start-playing-Agar-io
- Agar.io Wiki — Splitting: https://agario.fandom.com/wiki/Splitting
- Agar.io Wiki — Ejecting: https://agario.fandom.com/wiki/Ejecting
- Agar.io Wiki — Virus: https://agario.fandom.com/wiki/Virus
- Agar.io Wiki — Cell: https://agario.fandom.com/wiki/Cell
- Agar.io Wiki — FFA Mode: https://agario.fandom.com/wiki/FFA_Mode
- Ogar open-source server: https://github.com/OgarProject/Ogar
- owenashurst/agar.io-clone: https://github.com/owenashurst/agar.io-clone
- i-radwan/agar.io architecture notes: https://github.com/i-radwan/agar.io

## Branding note

“Agar.io” and Miniclip names are used only descriptively in documentation. The playable game is branded **Cell Arena** and ships no Agar.io logos, skins, or other official assets.
