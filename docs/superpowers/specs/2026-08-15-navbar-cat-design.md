# Navbar Cat — design

**Date:** 2026-08-15
**Status:** approved, implementing
**Plugin id:** `io.github.tallsam.navbar-cat`

## What it is

An Omarchy 4 shell plugin that draws a cat walking along the bar. The cat
roams the full bar width, reacts to what the system is doing, and can be
petted. It is a `kind: "panel"` plugin, so it mounts at login and lives for
the whole shell session.

## Decisions

| Question | Decision |
|---|---|
| Scope | Roams the whole bar, and reacts to system events |
| Art | Vendored oneko sprites — `neko`, later also `tora` and `dog` |
| Pointer | Chases the cursor, and is pettable |
| Reactions | Idle→sleep, music→bob, charging→nap, workspace→scamper |
| Sleep spot | Wherever the cat is — no fixed nap position (revised) |
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
characters used by permission. **`bsd`, `sakura`, and `tomoyo` are excluded
from this repo.** The first version vendored only `neko`; `tora` and `dog`
were added in the second round — neither carries a rights claim, so both fall
under the package's Public Domain declaration.

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
assets/<char>16-{fill,ink}.png  reduced sheets (<=16 device px)
assets/<char>32-{fill,ink}.png  native sheets (scaled/HiDPI outputs)
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
| 4 | Music playing | Dance on the spot (moved above charging) |
| 5 | On AC power | Get drowsy and curl up where it stands (revised) |
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
`<character>16-*.png` when the cat occupies ≤16 device px, else
`<character>32-*.png`.

## Configuration

Inline on the `plugins[]` entry in `~/.config/omarchy/shell.json`:

```json
{ "id": "io.github.tallsam.navbar-cat", "character": "neko", "speed": 1.0, "size": 16,
  "pettable": true, "chaseCursor": true, "pounce": true,
  "sleepAfter": 180, "stirEvery": 150, "stirFor": 25, "monitor": "focused",
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

## Second round — characters, pounce, stirring

Added after the first version was running.

**Characters.** `neko`, `tora`, and `dog` all use the same 32-frame layout, so
the whole feature is a `character:` key plus more sheets from the same build
script. `tora` ships no masks — oneko reuses neko's for it (`oneko.c:157`), and
so do we.

**The pounce.** Four diagonal poses (8 frames, a quarter of the sheet) were
defined but unreachable, because a cat on a 26px bar has no diagonal to walk.
Arriving at the pointer now triggers a leap out of the bar and back, on a
half-sine arc, with a 6s cooldown. This is the one behaviour that draws outside
the bar: the overlay grows inward by `catSize * 1.5`. The extra strip is
transparent and unmasked, and `pounce: false` shrinks the window back.

The leap is always *into* the screen — down from a top bar, up from a bottom
one — so `leapPose()` takes the bar's edge, not just the axis. Getting this
wrong would send the cat off-screen on half of all bar positions.

**Stirring.** A sleeping cat now books its own next wake-up, gets up, wanders,
and settles again. The brain returns `wakeIn` alongside `idle` so the body can
stop ticking and still set an alarm — without it, a cat on an unattended
machine slept until someone touched the mouse, which is to say forever.

*Bug caught by testing it live rather than only in unit tests:* the stir was
first written inside the idle-sleep rung, but the cat can also fall asleep on
the charger. A charging cat booked a wake-up, woke, immediately re-evaluated to
"charging", and went straight back to sleep without ever getting up — a loop
that looked exactly like nothing happening. The stir now sits above every rung
that can end in sleep and is keyed off `want.sleepy`, so it covers any future
sleepy rung too. There is a regression test.

## Third round — sleeping anywhere

The charging rung originally walked the cat to the right third of the bar to
"nap by the power widget". Watching it run showed two problems: the cat always
slept in the same place, and a cat that had stirred and wandered off would walk
all the way back to that spot before settling — the stir looked pointless.

Charging now only makes the cat drowsy; it sleeps where it stands. The cat is
also given a random starting position, because on a permanently-plugged-in
machine it settles immediately and would otherwise doze off in the left corner
every session.

This removes the last of the section-aiming fudge from the sleep behaviours.
Only the music reaction still aims at a position (the middle of the bar).

## Fourth round — music was unreachable on mains power

Reported from use: music was playing in a browser and the cat ignored it.

MPRIS was fine — Brave was publishing `PlaybackStatus = "Playing"` on the
session bus. The fault was the ladder. Charging sat at rung 4 and music at
rung 5, and charging is a *sleepy* rung that returns immediately. So on any
machine running on mains power — which for a laptop on a desk is all of the
time — rung 5 was never evaluated and the music reaction was dead code.

Music now sits above charging, and the general rule is written down: a rung
that wakes the cat outranks a rung that puts it to sleep. There is a test
asserting each of petted / chase / workspace / music beats charging, so the
next rung added below charging cannot quietly disappear the same way.

Worth noting the original test suite *asserted the bug* — "charging outranks
music" was written as if it were intended behaviour. Tests lock in whatever
the author believed at the time; they do not tell you the belief was wrong.
Only running it on a real machine did that.

## Fifth round — dance in place, and keep off the clock

Two related corrections, both about the cat assuming the middle of the bar was
free real estate.

The music reaction walked the cat to the centre to dance. The centre is where
Omarchy puts the clock by default, so the one reaction that reliably drew the
eye also reliably parked the cat on top of the time. It now dances wherever it
already is.

More generally, every spot the cat picks *for itself* — wander targets, stir
targets, and its position at startup — now avoids the middle `avoidCenter`
fraction of the bar, default 0.2. Three rules keep this from feeling like a
wall: the cat still walks through the middle, it still goes to the middle when
the pointer calls it there, and `avoidCenter: 0` turns it off for anyone whose
clock is not centred. This remains a guess about layout rather than knowledge
of it — nothing exposes widget geometry.

While wiring this up: the brain's generator was seeded with a constant, which
is what makes the wander tests reproducible but also meant every session
started the cat in the same place and sent it on the same route. The QML now
seeds it from the clock; the tests still pass their own seed.

## Out of scope

Multiple cats, cats on more than one monitor at once, walking between
monitors, notification reactions (the shell owns the notification server;
a second one cannot bind), and per-widget pixel-exact landmarks.
