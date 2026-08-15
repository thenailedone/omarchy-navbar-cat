# Navbar Cat

A cat that walks along the Omarchy bar.

It roams the full width of the bar, reacts to what your machine is doing, takes
your theme's colours, and can be petted. The sprites are the original
[oneko](http://www.daidouji.com/oneko/) cat, and so is the behaviour: left
alone, it sits, washes its face, scratches its head, yawns, and only then falls
asleep.

```
┌──────────────────────────────────────────────────────┐
│ ▣  1 2 3        🐈→          12:04       ▮ ⏻ │
└──────────────────────────────────────────────────────┘
```

## What it does

| When | The cat |
|---|---|
| You move the pointer onto the bar | runs to it, then sits and waits |
| You switch workspace | scampers in the direction you switched |
| You plug in the charger | drifts to the right of the bar and naps |
| Something is playing | drifts to the centre and bobs |
| You leave for a few minutes | settles down and falls asleep |
| Nothing in particular | wanders, with pauses |
| You click it | sits and looks pleased |

It walks the long way round on vertical bars too, and claws at the ends of the
bar when it wants to keep going and can't.

## Install

```bash
omarchy plugin add https://github.com/<you>/omarchy-navbar-cat.git --enable --yes
```

Or by hand:

```bash
git clone https://github.com/<you>/omarchy-navbar-cat.git \
  ~/.config/omarchy/plugins/sam.navbar-cat
omarchy-shell shell rescanPlugins
omarchy plugin enable sam.navbar-cat
```

## Configuration

Settings go inline on the plugin's entry in `~/.config/omarchy/shell.json`:

```json
{
  "plugins": [
    {
      "id": "sam.navbar-cat",
      "speed": 1.0,
      "size": 16,
      "pettable": true,
      "chaseCursor": true,
      "sleepAfter": 180,
      "monitor": "focused",
      "reactions": { "music": true, "charging": true, "workspace": true }
    }
  ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `speed` | `1.0` | Multiplier on walking and running pace |
| `size` | `16` | Cat height in logical pixels |
| `pettable` | `true` | Whether the cat can be clicked |
| `chaseCursor` | `true` | Whether the cat comes when you visit the bar |
| `sleepAfter` | `180` | Seconds of pointer stillness before it sleeps |
| `monitor` | `"focused"` | `"focused"` to follow you, or an output name to pin it |
| `reactions` | all on | Individually disable the music, charging, or workspace reactions |

## Does it get in the way?

No. The overlay is click-through everywhere the cat is not, and while the cat
is *moving* it is click-through everywhere at all — the small clickable box
only exists once the cat has settled somewhere, and disappears the moment it
sets off again. Set `pettable: false` to remove even that.

It costs almost nothing at rest, either: a sleeping cat stops its own render
timer, and the pointer sampler slows down to match.

## How it is put together

| File | Role |
|---|---|
| `Cat.qml` | The panel: window, monitor tracking, event sources, tick loop |
| `CatSprite.qml` | Frame selection, sheet choice, two-tone theming |
| `Brain.js` | All the behaviour, as a pure function — the tested part |
| `bin/navbar-cat-cursor` | Pointer sampler |
| `tools/build-sprites.py` | XBM → spritesheets (only needed to change the art) |

`Brain.js` takes a snapshot of the world and returns what the cat should be
doing. It holds no QML and reads no clock of its own, so the whole priority
ladder is testable with a fake clock:

```bash
node --test "test/*.test.mjs"
```

### Two things worth knowing

**The pointer is sampled, not subscribed to.** Hyprland has no cursor-move
event and Quickshell exposes no pointer position, so something has to ask.
Asking via `hyprctl` costs ~8ms per sample — 8% of a core at 10Hz, which is an
absurd price for a cat. `bin/navbar-cat-cursor` makes the same request straight
to the Hyprland socket for ~0.03ms, which is 285× cheaper and the reason this
feature exists at all.

**The cat aims at thirds of the bar, not at widgets.** Nothing in the bar
exposes widget geometry, so "naps by the power icon" really means "settles in
the right third of the bar". On an unusual layout it will look slightly off,
and that is why.

## Sprites and licence

The plugin's own code is MIT. The sprites are the **public-domain** `neko` cat
from oneko 1.2.sakura.5 — see [`vendor/oneko-neko/PROVENANCE.md`](vendor/oneko-neko/PROVENANCE.md)
for the exact source and checksum.

oneko's tarball also ships character sets that are **not** free — the BSD
Daemon is Marshall Kirk McKusick's, and Sakura and Tomoyo are CLAMP characters.
None of those are vendored here. Only the original cat is.
