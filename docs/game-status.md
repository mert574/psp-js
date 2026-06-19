# Game compatibility (2026-06-19)

A snapshot of how each tested game runs.

## Compatibility ratings

From best to worst:

| Rating | Meaning |
|---|---|
| <span class="rt rt-perfect">Perfect</span> | Runs with no noticeable problems. |
| <span class="rt rt-playable">Playable</span> | Playable start to finish, only minor issues. |
| <span class="rt rt-ingame">Ingame</span> | Reaches gameplay but with significant glitches or low speed. |
| <span class="rt rt-menu">Menu/Intro</span> | Reaches menus or intro videos, not gameplay. |
| <span class="rt rt-noboot">Doesn't Boot</span> | Crashes at boot or shows nothing. |

## Games

| Game | Game ID | Compatibility | Notes |
|---|---|---|---|
| Metal Slug XX | ULUS10495 | <span class="rt rt-playable">Playable</span> | Renders correctly. |
| Puzzle Bobble | ULJM05011 | <span class="rt rt-playable">Playable</span> | Full speed with sound. |
| Burnout Legends | ULES00125 | <span class="rt rt-ingame">Ingame</span> | Graphical glitches. |
| Cladun | NPEH00084 | <span class="rt rt-ingame">Ingame</span> | Low FPS in some scenes. No sound. |
| Duke3D | homebrew | <span class="rt rt-ingame">Ingame</span> | Boots and works without issues, but low FPS. |
| Gran Turismo | UCES01245 | <span class="rt rt-ingame">Ingame</span> | Graphical glitches and low FPS. |
| Puyo Puyo | ULJM05058 | <span class="rt rt-ingame">Ingame</span> | Menus, logo, and text render. |
| Ridge Racer | ULUS10001 | <span class="rt rt-ingame">Ingame</span> | 3D models render in-race. |
| Toy Story 3 | ULES01406 | <span class="rt rt-ingame">Ingame</span> | Visual glitches and a save-game issue. |
| Dragon Ball Z Shin Budokai | ULES00309 | <span class="rt rt-menu">Menu/Intro</span> |  |
| God of War: Ghost of Sparta | UCUS98737 | <span class="rt rt-menu">Menu/Intro</span> | Blank screen after the intro; never reaches the menu. |
| Wipeout Pure | UCUS98612 | <span class="rt rt-menu">Menu/Intro</span> | Intro videos play (WebCodecs H.264) and menus render. |
| Grand Theft Auto: Vice City Stories | ULUS10160 | <span class="rt rt-noboot">Doesn't Boot</span> |  |
| LEGO Batman: The Videogame | ULES01151 | <span class="rt rt-noboot">Doesn't Boot</span> |  |
| LittleBigPlanet | UCES01264 | <span class="rt rt-noboot">Doesn't Boot</span> | Fails with "pthread API call from non-pthread thread"; our threads are not registered as SCE pthreads. |
| Space Invaders | ULES01078 | <span class="rt rt-noboot">Doesn't Boot</span> | Black screen. Event-flag bits are never set, then a CPU spin loop. Likely an intro-video wait. |

## Known issues

**Rendering**

- Deferred GPU-accuracy gaps, each with a reason in the code: 16-bit color replication, WebGL doubled-alpha blend, FRAMEBUFWIDTH high bits, morph weights, WebGL CLUT hashing.

**Performance**

- God of War is slow. WebGL draws are already batched by render state, so the cost that's left is the MIPS interpreter and GE vertex processing.

**Audio**

- SAS (`sceSas`) synthesizes only VAG and PCM voices (plus pitch, L/R volume, ADSR). Not done: ATRAC3 voices, noise/triangle/pulse waveform voices, and the reverb/effect-send path (dry mixing only).
- No MPEG or SAS reverb. MPEG cutscene audio via `sceMpegAtracDecode` is decoded and played.

## Planned work

1. sceMpeg intro-video handling for the games that still block on it.
2. Speed up God of War: the MIPS interpreter and GE vertex processing are the slow parts now.
3. Revive the GE Web Worker to move GE work off the main thread, ideally over a SharedArrayBuffer command ring.
4. Utility dialog status numbering for msgdialog, netconf, and osk.

<style>
.rt {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 6px;
  font-size: 0.85em;
  font-weight: 600;
  white-space: nowrap;
  color: #fff;
}
.rt-perfect { background: #15803d; }
.rt-playable { background: #22a06b; }
.rt-ingame { background: #eab308; color: #1a1a1a; }
.rt-menu { background: #ea7317; }
.rt-noboot { background: #dc2626; }
</style>
