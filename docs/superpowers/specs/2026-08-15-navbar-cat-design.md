# Navbar Cat — design

**Date:** 2026-08-15
**Status:** approved, implementing
**Plugin id:** `sam.navbar-cat`

## What it is

An Omarchy 4 shell plugin that draws a cat walking along the bar. The cat
roams the full bar width, reacts to what the system is doing, and can be
petted. It is a `kind: "panel"` plugin, so it mounts at login and lives for
the whole shell session.

## Decisions

| Question | Decision |
|---|---|
| Scope | Roams the whole bar, and reacts to system events |
| Art | Vendored oneko sprites (`neko` set only) |
| Pointer | Chases the cursor, and is pettable |
| Reactions | Idle→sleep, music→bob, charging→nap, workspace→scamper |
| Landmarks | Section aiming (left/centre/right thirds), no perch widgets |
| Size | 16 logical px, inside the bar, never overlapping windows |

## Verified assumptions

These were checked against the installed system before writing code, not
assumed:

- **`keepLoaded` panels mount at startup.** `shell.qml:625` sets the panel
  Loader `active: sourceUrl !== "" && (keepLoaded || openPanelIds[id])`.
  A `kind: "panel"` + `keepLoaded: true` plugin therefore loads at login
  with no autostart entry and no summon.
- **Third-party plugins may import shell singletons.** Both
  `sam.legion-rgb` and `taxin.cursor-style` `import qs.Commons` / `qs.Ui`,
  so `Color.bar.text` and `Color.bar.background` are reachable and update
  live on theme switch.
- **Drawing above the bar is a sanctioned pattern.** The bar itself is
  `WlrLayer.Top` (`Bar.qml:1024`); its own drag ghost is `WlrLayer.Overlay`
  (`Bar.qml:1167`). Our overlay uses the same layer.
- **The shell injects context into panel plugins.** `shell.qml:629-637`
  assigns `omarchyPath`, `shell`, `manifest`, and `pluginRegistry` onto the
  loaded item when those properties exist.
- **Bar geometry is not queryable.** `Bar.qml` registers no `IpcHandler`,
  and no plugin API exposes widget positions. Hence section aiming.
- **`QtQuick.Effects` (MultiEffect) is installed** and already used four
  times in the shell — available for two-tone tinting.
- **`Quickshell.Services.Mpris` and `.UPower` are installed** and used by
  the shell, so the music and charging reactions have data sources.

## Risk resolutions

**1. Sprite licence — RESOLVED, usable.**
The AUR `oneko` PKGBUILD declares `license=('Public Domain')`. The upstream
tarball (`oneko-1.2.sakura.5.tar.gz`, md5 `456b318f...`, matching the
PKGBUILD checksum) was downloaded and inspected.

**Important carve-out:** `oneko.man` reserves rights on specific character
sets shipped in the same tarball — the BSD Daemon is "Copyright 1988 by
Marshall Kirk McKusick. All Rights Reserved", and Sakura/Tomoyo are CLAMP
characters used by permission. **We vendor only `bitmaps/neko/` and
`bitmasks/neko/`** — the original public-domain cat. `bsd`, `sakura`,
`tomoyo`, `dog`, and `tora` are excluded from this repo.

**2. Cursor position — RESOLVED, cheaper than expected.**
Quickshell exposes no cursor position (no match for `cursorpos` anywhere in
its QML modules), and Hyprland emits no cursor-move event. Sampling is
required. Measured on this machine:

| Method | Cost per sample | At 10Hz |
|---|---|---|
| `hyprctl cursorpos` (exec) | 8.0 ms | ~8% of a core |
| Raw Hyprland socket (no exec) | 0.028 ms | ~0.03% of a core |

The 285× difference decides it: `bin/navbar-cat-cursor` is a small Python
daemon holding no persistent connection but paying only socket syscalls, and
streams `x y` lines on stdout. Cursor chase ships as designed, with no
compromise. The daemon still idles its rate down when the cat sleeps,
because it is free to do so.

**3. Input-mask churn — MITIGATED BY DESIGN.**
The input region is empty while the cat moves and becomes a 16×16 box only
once it settles. A moving cat was never clickable, so this costs nothing in
feel and reduces region commits to a couple per minute.

## Architecture

```
Cat.qml           panel entry: PanelWindow, mask, monitor + bar tracking
CatSprite.qml     frame selection, sheet choice by DPR, two-tone tinting
Brain.js          pure behaviour core — no QML, no side effects, tested
assets/cat16.png  reduced sheet (used when 16 device px or fewer)
assets/cat32.png  native sheet (used on scaled/HiDPI outputs)
bin/navbar-cat-cursor   cursor sampler daemon
tools/build-sprites.py  XBM -> spritesheets (dev only; output committed)
test/brain.test.mjs     fake-clock tests of the priority ladder
```

**Brain.js** takes a snapshot of inputs and returns `{targetX, gait, pose}`.
Priority ladder, first match wins:

| # | Trigger | Behaviour |
|---|---|---|
| 1 | Recently petted | Sit and purr, hold position |
| 2 | Pointer over the bar | Run to it, then sit and wait |
| 3 | Workspace switched | Scamper in the switch direction |
| 4 | On AC power | Drift to right third, curl up |
| 5 | Music playing | Drift to centre, bob |
| 6 | No pointer movement for `sleepAfter` | Sleep in place |
| 7 | Nothing | Wander with pauses |

**Rendering.** One `Timer` advances position; it stops entirely when the cat
is asleep with no pending event, so a sleeping cat costs nothing.

*Changed during implementation:* the tick runs at 30fps rather than the 15fps
first specified. At 15fps a running cat moves 10px per frame, which reads as
stuttering rather than running. Sprite frames still advance on their own
slower 150ms timer, matching oneko's cadence — the fast tick is only for
position.

**Sprite sheets.** Frames are 32×32 two-colour XBM pairs (image + mask).
Within the mask, image bit set = ink, clear = fill. Rendered as two
alpha-only sheets stacked and tinted: fill in `Color.bar.text`, ink in
`Color.bar.background` — matching oneko's original white-body/black-outline
cat, themed. The 16px sheet is reduced with an **ink-if-any** 2×2 rule,
chosen over a majority rule because majority breaks the 1px outlines apart
and the cat stops reading as a cat. Sheet choice is by device pixel ratio:
`cat16.png` when the cat occupies ≤16 device px, else `cat32.png`.

## Configuration

Inline on the `plugins[]` entry in `~/.config/omarchy/shell.json`:

```json
{ "id": "sam.navbar-cat", "speed": 1.0, "pettable": true,
  "chaseCursor": true, "sleepAfter": 180, "monitor": "focused",
  "reactions": { "music": true, "charging": true, "workspace": true } }
```

## Testing

`Brain.js` is pure, so the priority ladder is tested directly with a fake
clock and synthetic input snapshots — every rung, plus the transitions
between them. The QML layer gets a manual QA checklist (bar positions,
theme switch, monitor migration, bar hidden).

## Found while building

Four things the design did not anticipate, recorded because each cost real
time to diagnose:

1. **MultiEffect renders nothing from an invisible source.** Tinting was
   written as `MultiEffect { source: hiddenItem }`, hiding the untinted sheet
   so it would not draw over the tinted one. The effect then had nothing to
   render and the cat never appeared, despite the brain running correctly the
   whole time. The working form — and the one the rest of the shell uses — is
   `layer.enabled: true` with `layer.effect: MultiEffect`.
2. **Never name a QML id `layer`.** It collides with the built-in `layer`
   grouped property, so `layer.tint` silently resolved to the grouped property
   instead of the id. `colorizationColor` fell back to its default, which is
   red, and produced a bright red cat.
3. **A closed stdin is permanently readable.** The cursor helper ended itself
   on stdin EOF as a parent-death check. Because `select()` always reports a
   closed stdin as ready and `readline()` returns `""`, the helper exited after
   a single sample. Lifetime is now `PR_SET_PDEATHSIG`, which does not depend
   on anyone writing to us.
4. **Anything derived from `manifest` is empty at construction.** The shell
   assigns `manifest` after the component is built, so the sprite briefly asked
   for `/cat32-fill.png` and the helper was launched as `/bin/navbar-cat-cursor`.
   Both are now gated behind a `ready` flag.

Also adjusted after seeing it run: petting played the face-washing frame from
the very first frame, which reads as the cat ignoring the click. It now looks
up for 450ms before settling into grooming.

## Verification

Confirmed on the running shell, not just in tests:

- The layer surface lands at exactly `0 0 1600 26`, over the bar.
- The cat renders in theme colours and re-tints on theme change.
- Chase works end to end: with the pointer parked at logical 1400 the cat ran
  to target 1392 at the configured 150px/s, arrived, and held `pos=693,
  pose=stop, settled=true` with no jitter.
- The charging rung fires on this machine (it is plugged in) and aims at the
  right third.
- The pettable input region is live — the sprite's MouseArea receives enter
  and exit events once the cat settles under the pointer.

Petting itself could not be driven from a script: this Hyprland exposes only
`hl.dsp.cursor.move` and `move_to_corner`, with no button synthesis, and
`wtype` is keyboard-only. Hover was used as the proxy, since it exercises the
same input-region path. The user confirmed clicking works by trying it.

## Out of scope

Multiple cats, cats on more than one monitor at once, walking between
monitors, notification reactions (the shell owns the notification server;
a second one cannot bind), and per-widget pixel-exact landmarks.
