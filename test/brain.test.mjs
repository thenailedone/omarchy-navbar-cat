// Tests for the cat's behaviour core.
//
// Brain.js is loaded by evaluating it rather than importing it, because it is
// a QML .js resource: QML exposes its top-level functions directly and has no
// export statement for node to read. Evaluating it here keeps one copy of the
// logic serving both the shell and this suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(REPO, "Brain.js"), "utf8");
const Brain = new Function(
  `${source}\nreturn { decide, freshState, CHAIN, PET_MS, PET_PERK_MS, AWAKE_MS,`
    + ` SCAMPER_MS, POUNCE_MS, POUNCE_COOLDOWN_MS };`,
)();

const DIAGONALS = new Set(["upleft", "upright", "dwleft", "dwright"]);

// Drive the cat all the way down to sleep from a fresh state, and hand back the
// decision and the clock reading at that moment. Several tests need a genuinely
// sleeping cat as their starting point.
function sleepingCat(overrides = {}) {
  const chainTotal = Brain.CHAIN.reduce(
    (sum, step) => sum + (Number.isFinite(step.ms) ? step.ms : 0),
    0,
  );
  const start = 300_000;
  let out = Brain.decide(
    input({ now: start, lastPointerMoveAt: 10_000, x: 500, ...overrides }),
    Brain.freshState(),
  );
  const asleepAt = start + chainTotal + 1000;
  out = Brain.decide(
    input({ now: asleepAt, lastPointerMoveAt: 10_000, x: out.target, ...overrides }),
    out.state,
  );
  return { out, asleepAt, chainTotal };
}

const BAR = 1000;
const CAT = 16;

// A snapshot with nothing going on: pointer off the bar, nothing playing,
// on battery, pointer moved a moment ago. Every test overrides just the field
// it cares about, so a rung firing is unambiguous.
function input(overrides = {}) {
  return {
    now: 10_000,
    axis: "h",
    barLength: BAR,
    catSize: CAT,
    x: 500,
    pointer: null,
    pettedAt: null,
    lastPointerMoveAt: 10_000,
    music: false,
    charging: false,
    workspaceEvent: null,
    config: {
      chaseCursor: true,
      pettable: true,
      sleepAfter: 180,
      reactions: { music: true, charging: true, workspace: true },
    },
    ...overrides,
  };
}

function decide(overrides, state = Brain.freshState()) {
  return Brain.decide(input(overrides), state);
}

test("rung 7: with nothing happening the cat wanders", () => {
  const out = decide({});
  assert.equal(out.reason, "wander");
});

test("rung 7: a wander target stays put across ticks until reached", () => {
  let state = Brain.freshState();
  const first = Brain.decide(input({}), state);
  const second = Brain.decide(input({ now: 10_100 }), first.state);
  assert.equal(first.target, second.target, "cat should not re-roll its target every tick");
});

test("rung 6: no pointer movement past sleepAfter puts the cat to sleep", () => {
  // Far past the threshold and standing on its target, so the idle chain has
  // had time to run all the way down to sleep.
  let state = Brain.freshState();
  let out = Brain.decide(
    input({ now: 300_000, lastPointerMoveAt: 10_000, x: 500 }),
    state,
  );
  // Let the chain elapse: feed the same resting situation well past its end.
  const chainTotal = Brain.CHAIN.reduce(
    (sum, step) => sum + (Number.isFinite(step.ms) ? step.ms : 0),
    0,
  );
  out = Brain.decide(
    input({ now: 300_000 + chainTotal + 1000, lastPointerMoveAt: 10_000, x: out.target }),
    out.state,
  );
  assert.equal(out.pose, "sleep");
  assert.equal(out.reason, "idle-sleep");
});

test("rung 6: the idle chain runs stop -> wash -> scratch -> yawn -> sleep", () => {
  // Faithful to oneko's own progression (oneko.c:1107 onward).
  const seen = [];
  let state = Brain.freshState();
  let t = 300_000;
  let x = 500;
  // Prime: arrive at rest.
  let out = Brain.decide(input({ now: t, lastPointerMoveAt: 10_000, x }), state);
  x = out.target;
  for (const step of Brain.CHAIN) {
    out = Brain.decide(
      input({ now: t, lastPointerMoveAt: 10_000, x }),
      out.state,
    );
    seen.push(out.pose);
    t += Number.isFinite(step.ms) ? step.ms : 1000;
  }
  assert.deepEqual(seen, ["stop", "wash", "scratch", "yawn", "sleep"]);
});

test("rung 5: music walks the cat to the centre and bobs", () => {
  const out = decide({ music: true, x: 100 });
  assert.equal(out.reason, "music");
  assert.ok(
    Math.abs(out.target - (BAR - CAT) / 2) < 1,
    `expected centre, got ${out.target}`,
  );
  const arrived = decide({ music: true, x: out.target });
  assert.equal(arrived.bob, true, "cat should bob once it has arrived");
});

test("rung 5: music is ignored when its reaction is switched off", () => {
  const out = decide({
    music: true,
    config: { ...input().config, reactions: { music: false, charging: true, workspace: true } },
  });
  assert.equal(out.reason, "wander");
});

test("rung 4: charging makes the cat sleepy where it stands", () => {
  // It used to be marched to the right third to "nap by the power widget".
  // A cat sleeps where it is, and being summoned to a fixed spot meant it
  // always slept in the same place and trudged back there after every stir.
  for (const x of [40, 500, BAR - CAT]) {
    const out = decide({ charging: true, x });
    assert.equal(out.reason, "charging");
    assert.equal(out.target, x, "charging should not relocate the cat");
    assert.equal(out.gait, "idle");
  }
});

test("music outranks charging, so mains power cannot silence it", () => {
  // Regression: charging used to come first. Because charging is a sleepy rung
  // that returns immediately, a laptop on mains power — which is most laptops,
  // most of the time — made the music reaction unreachable entirely.
  const out = decide({ charging: true, music: true, x: 100 });
  assert.equal(out.reason, "music");

  // Charging still wins when there is nothing playing.
  const quiet = decide({ charging: true, music: false, x: 100 });
  assert.equal(quiet.reason, "charging");
});

test("waking reactions all beat charging", () => {
  // The general rule the bug above violated: anything that means the cat
  // should be up and doing something outranks anything that puts it to sleep.
  const cases = [
    [{ pettedAt: 9_500 }, "petted"],
    [{ pointer: { onBar: true, pos: 300 } }, "chase"],
    [{ workspaceEvent: { at: 9_800, dir: 1 } }, "workspace"],
    [{ music: true }, "music"],
  ];
  for (const [extra, expected] of cases) {
    const out = decide({ charging: true, x: 100, ...extra });
    assert.equal(out.reason, expected, `${expected} should beat charging`);
  }
});

test("rung 4: a charging cat eventually naps, right where it was", () => {
  const chainTotal = Brain.CHAIN.reduce(
    (sum, step) => sum + (Number.isFinite(step.ms) ? step.ms : 0),
    0,
  );
  let out = decide({ charging: true, x: 100 });
  assert.equal(out.pose, "stop", "settles before it sleeps");
  out = Brain.decide(
    input({ charging: true, x: 100, now: 10_000 + chainTotal + 2000 }),
    out.state,
  );
  assert.equal(out.pose, "sleep");
  assert.equal(out.target, 100, "and sleeps where it already was");
});

test("rung 3: a workspace switch scampers the cat that way", () => {
  const right = decide({ workspaceEvent: { at: 9_800, dir: 1 }, x: 500 });
  assert.equal(right.reason, "workspace");
  assert.ok(right.target > 500, "switching right should send the cat right");
  assert.equal(right.gait, "run");

  const left = decide({ workspaceEvent: { at: 9_800, dir: -1 }, x: 500 });
  assert.ok(left.target < 500, "switching left should send the cat left");
});

test("rung 3: a stale workspace switch stops mattering", () => {
  const out = decide({ workspaceEvent: { at: 1_000, dir: 1 } });
  assert.equal(out.reason, "wander");
});

test("rung 3: a scamper cannot leave the bar", () => {
  const out = decide({ workspaceEvent: { at: 9_800, dir: 1 }, x: BAR - CAT - 5 });
  assert.ok(out.target <= BAR - CAT, `target ${out.target} escaped the bar`);
});

test("rung 2: the cat runs to a pointer on the bar", () => {
  const out = decide({ pointer: { onBar: true, pos: 900 }, x: 100 });
  assert.equal(out.reason, "chase");
  assert.equal(out.gait, "run");
  assert.equal(out.pose, "right");
  assert.ok(Math.abs(out.target - (900 - CAT / 2)) < 1);
});

test("rung 2: having reached the pointer, the cat sits and waits", () => {
  // Pounce off: arriving at the pointer is also the pounce trigger, and this
  // test is about what the cat does once it has landed and settled.
  const out = decide({
    pointer: { onBar: true, pos: 500 },
    x: 500 - CAT / 2,
    config: { ...input().config, pounce: false },
  });
  assert.equal(out.reason, "chase");
  assert.equal(out.gait, "idle");
  assert.equal(out.pose, "stop", "a waiting cat should not fall asleep on the job");
});

test("rung 2: chase outranks charging and music", () => {
  const out = decide({
    pointer: { onBar: true, pos: 100 },
    charging: true,
    music: true,
    x: 900,
  });
  assert.equal(out.reason, "chase");
});

test("rung 2: chaseCursor off means the pointer is ignored", () => {
  const out = decide({
    pointer: { onBar: true, pos: 900 },
    config: { ...input().config, chaseCursor: false },
  });
  assert.equal(out.reason, "wander");
});

test("rung 1: a freshly petted cat holds still and looks pleased", () => {
  const out = decide({ pettedAt: 9_500, x: 400 });
  assert.equal(out.reason, "petted");
  assert.equal(out.gait, "idle");
  assert.equal(out.target, 400, "a petted cat should not wander off");
});

test("rung 1: petting gets an acknowledgement before the grooming", () => {
  // Clicking and being met instantly with face-washing reads as the cat
  // ignoring you. It should look up first, then settle into grooming.
  const now = 10_000;
  const immediate = decide({ pettedAt: now - 10, x: 400 });
  assert.equal(immediate.pose, "awake", "should look up when clicked");

  const later = decide({ pettedAt: now - Brain.PET_PERK_MS - 10, x: 400 });
  assert.equal(later.pose, "wash", "then settle into contented grooming");

  const done = decide({ pettedAt: now - Brain.PET_MS - 1, x: 400 });
  assert.notEqual(done.reason, "petted");
});

test("rung 1: petting outranks even the pointer", () => {
  const out = decide({ pettedAt: 9_500, pointer: { onBar: true, pos: 900 }, x: 400 });
  assert.equal(out.reason, "petted");
});

test("rung 1: the pleasure wears off", () => {
  const out = decide({ pettedAt: 9_500 - Brain.PET_MS - 1, x: 400 });
  assert.notEqual(out.reason, "petted");
});

test("waking: a sleeping cat plays its awake frame before it moves", () => {
  // Put it to sleep, then give it a reason to move.
  let out = decide({ now: 300_000, lastPointerMoveAt: 10_000, x: 500 });
  const chainTotal = Brain.CHAIN.reduce(
    (sum, s) => sum + (Number.isFinite(s.ms) ? s.ms : 0),
    0,
  );
  const asleepAt = 300_000 + chainTotal + 1000;
  out = Brain.decide(
    input({ now: asleepAt, lastPointerMoveAt: 10_000, x: out.target }),
    out.state,
  );
  assert.equal(out.pose, "sleep");

  const woken = Brain.decide(
    input({ now: asleepAt + 10, pointer: { onBar: true, pos: 50 }, x: out.target }),
    out.state,
  );
  assert.equal(woken.pose, "awake");
  assert.equal(woken.gait, "idle", "the cat should not sprint before its eyes open");

  const moving = Brain.decide(
    input({
      now: asleepAt + Brain.AWAKE_MS + 20,
      pointer: { onBar: true, pos: 50 },
      x: out.target,
    }),
    woken.state,
  );
  assert.equal(moving.gait, "run", "after waking it should get going");
});

test("edges: a cat that wants to walk past the end claws at it instead", () => {
  const noPounce = { ...input().config, pounce: false };
  const out = decide({
    pointer: { onBar: true, pos: BAR + 200 },
    x: BAR - CAT,
    config: noPounce,
  });
  assert.equal(out.pose, "rtogi");

  const left = decide({ pointer: { onBar: true, pos: -200 }, x: 0, config: noPounce });
  assert.equal(left.pose, "ltogi");
});

test("vertical bars: the cat uses up and down frames", () => {
  const down = decide({ axis: "v", pointer: { onBar: true, pos: 900 }, x: 100 });
  assert.equal(down.pose, "down");
  const up = decide({ axis: "v", pointer: { onBar: true, pos: 100 }, x: 900 });
  assert.equal(up.pose, "up");
});

test("vertical bars: edge clawing uses the top and bottom frames", () => {
  const noPounce = { ...input().config, pounce: false };
  const bottom = decide({
    axis: "v", pointer: { onBar: true, pos: BAR + 200 }, x: BAR - CAT, config: noPounce,
  });
  assert.equal(bottom.pose, "dtogi");
  const top = decide({
    axis: "v", pointer: { onBar: true, pos: -200 }, x: 0, config: noPounce,
  });
  assert.equal(top.pose, "utogi");
});

test("petting is only offered while the cat is settled", () => {
  const moving = decide({ pointer: { onBar: true, pos: 900 }, x: 100 });
  assert.equal(moving.pettable, false, "a walking cat must not hold an input region");

  const settled = decide({
    pointer: { onBar: true, pos: 500 },
    x: 500 - CAT / 2,
    config: { ...input().config, pounce: false },
  });
  assert.equal(settled.pettable, true);
});

test("petting is never offered when the user has switched it off", () => {
  const out = decide({
    pointer: { onBar: true, pos: 500 },
    x: 500 - CAT / 2,
    config: { ...input().config, pettable: false, pounce: false },
  });
  assert.equal(out.pettable, false);
});

test("the cat never targets a position that would hang off the bar", () => {
  // Sweep the ladder with hostile geometry and check the invariant holds.
  const cases = [
    { pointer: { onBar: true, pos: 5 } },
    { pointer: { onBar: true, pos: BAR - 1 } },
    { charging: true },
    { music: true },
    { workspaceEvent: { at: 9_800, dir: 1 } },
    { workspaceEvent: { at: 9_800, dir: -1 } },
    {},
  ];
  for (const c of cases) {
    for (const x of [0, 250, BAR - CAT]) {
      const out = decide({ ...c, x });
      assert.ok(
        out.target >= 0 && out.target <= BAR - CAT,
        `target ${out.target} out of bounds for ${JSON.stringify(c)} at x=${x}`,
      );
    }
  }
});

test("a bar too narrow for the cat does not produce a negative target", () => {
  const out = decide({ barLength: 10, x: 0 });
  assert.ok(out.target >= 0 && Number.isFinite(out.target), `got ${out.target}`);
});

// ------------------------------------------------------------------ stirring

test("stir: a sleeping cat says when it next wants waking", () => {
  const { out } = sleepingCat();
  assert.equal(out.pose, "sleep");
  assert.ok(out.wakeIn > 0, "a sleeping cat must ask to be woken, or it sleeps forever");
});

test("stir: the cat rouses itself after a while and wanders", () => {
  const { out, asleepAt } = sleepingCat();
  // Well past the longest possible randomised interval.
  const later = asleepAt + out.wakeIn + 10;
  const stirred = Brain.decide(
    input({ now: later, lastPointerMoveAt: 10_000, x: out.target }),
    out.state,
  );
  assert.equal(stirred.reason, "stir");
  assert.notEqual(stirred.pose, "sleep", "it should be up and about");
});

test("stir: having pottered about, it goes back to sleep", () => {
  const { out, asleepAt, chainTotal } = sleepingCat();
  let state = out.state;
  let now = asleepAt + out.wakeIn + 10;

  let stirred = Brain.decide(input({ now, lastPointerMoveAt: 10_000, x: out.target }), state);
  assert.equal(stirred.reason, "stir");

  // Run past the whole stir window, standing where it was asked to go.
  now += 25_000 + 1000;
  let back = Brain.decide(
    input({ now, lastPointerMoveAt: 10_000, x: stirred.target }),
    stirred.state,
  );
  assert.equal(back.reason, "idle-sleep", "the stir should expire back into sleeping");

  // And then settle all the way down again.
  now += chainTotal + 1000;
  const asleepAgain = Brain.decide(
    input({ now, lastPointerMoveAt: 10_000, x: back.target }),
    back.state,
  );
  assert.equal(asleepAgain.pose, "sleep");
});

test("stir: a cat asleep on the charger stirs too, not just an idle one", () => {
  // Regression: the stir originally lived inside the idle-sleep rung, so a cat
  // that had nodded off on AC power booked a wake-up and then went straight
  // back to sleep without ever getting up.
  const chainTotal = Brain.CHAIN.reduce(
    (sum, s) => sum + (Number.isFinite(s.ms) ? s.ms : 0),
    0,
  );
  let out = decide({ charging: true, x: 100 });
  out = Brain.decide(
    input({ charging: true, x: 100, now: 10_000 + chainTotal + 2000 }),
    out.state,
  );
  assert.equal(out.pose, "sleep");
  assert.ok(out.wakeIn > 0, "a charging cat should book its own stir");

  const stirred = Brain.decide(
    input({
      charging: true,
      x: 100,
      now: 10_000 + chainTotal + 2000 + out.wakeIn + 10,
    }),
    out.state,
  );
  assert.equal(stirred.reason, "stir");
});

test("stir: after pottering about it settles wherever it ended up", () => {
  // The point of letting it sleep anywhere: having stirred and wandered off,
  // the cat must not walk all the way back to where it slept before.
  const chainTotal = Brain.CHAIN.reduce(
    (sum, s) => sum + (Number.isFinite(s.ms) ? s.ms : 0),
    0,
  );
  let out = decide({ charging: true, x: 100 });
  out = Brain.decide(
    input({ charging: true, x: 100, now: 10_000 + chainTotal + 2000 }),
    out.state,
  );
  let now = 10_000 + chainTotal + 2000 + out.wakeIn + 10;

  const stirred = Brain.decide(input({ charging: true, x: 100, now }), out.state);
  assert.equal(stirred.reason, "stir");
  const wanderedTo = stirred.target;
  assert.notEqual(wanderedTo, 100, "it should have somewhere new in mind");

  // Let the stir run out while standing at the new spot.
  now += 25_000 + 1000;
  const settling = Brain.decide(
    input({ charging: true, x: wanderedTo, now }),
    stirred.state,
  );
  assert.equal(settling.reason, "charging");
  assert.equal(
    settling.target, wanderedTo,
    "it should settle where it wandered to, not march back",
  );
});

test("stir: waking for a real reason clears the stir schedule", () => {
  const { out, asleepAt } = sleepingCat();
  const chased = Brain.decide(
    input({ now: asleepAt + 50, pointer: { onBar: true, pos: 100 }, x: out.target }),
    out.state,
  );
  assert.equal(chased.wakeIn, 0, "an awake cat has no pending self-wake");
});

// ------------------------------------------------------------------- pouncing

test("pounce: catching up with the pointer triggers a pounce", () => {
  const settled = decide({ pointer: { onBar: true, pos: 500 }, x: 300 });
  // Walk it in so the cat has a direction, then arrive.
  const arriving = Brain.decide(
    input({ pointer: { onBar: true, pos: 500 }, x: 492 }),
    settled.state,
  );
  assert.equal(arriving.reason, "pounce");
  assert.ok(DIAGONALS.has(arriving.pose), `expected a diagonal frame, got ${arriving.pose}`);
});

test("pounce: the arc lifts off and lands", () => {
  const start = decide({ pointer: { onBar: true, pos: 500 }, x: 300 });
  let out = Brain.decide(input({ pointer: { onBar: true, pos: 500 }, x: 492 }), start.state);
  const lifts = [out.lift];
  for (const at of [0.25, 0.5, 0.75]) {
    out = Brain.decide(
      input({ now: 10_000 + Brain.POUNCE_MS * at, pointer: { onBar: true, pos: 500 }, x: 492 }),
      out.state,
    );
    lifts.push(out.lift);
  }
  assert.ok(lifts[2] > lifts[0], "should be higher mid-pounce than at the start");
  assert.ok(lifts[2] >= lifts[3], "and coming back down by the end");
  assert.ok(Math.max(...lifts) <= 1.0001, "lift is normalised to 0..1");

  const after = Brain.decide(
    input({ now: 10_000 + Brain.POUNCE_MS + 50, pointer: { onBar: true, pos: 500 }, x: 492 }),
    out.state,
  );
  assert.notEqual(after.reason, "pounce", "the pounce must end");
  assert.equal(after.lift, 0);
});

test("pounce: it does not pounce again immediately", () => {
  const start = decide({ pointer: { onBar: true, pos: 500 }, x: 300 });
  let out = Brain.decide(input({ pointer: { onBar: true, pos: 500 }, x: 492 }), start.state);
  out = Brain.decide(
    input({ now: 10_000 + Brain.POUNCE_MS + 50, pointer: { onBar: true, pos: 500 }, x: 492 }),
    out.state,
  );
  assert.notEqual(out.reason, "pounce");
  const soon = Brain.decide(
    input({ now: 10_000 + Brain.POUNCE_MS + 200, pointer: { onBar: true, pos: 500 }, x: 492 }),
    out.state,
  );
  assert.notEqual(soon.reason, "pounce", "cooldown should hold it back");

  const eventually = Brain.decide(
    input({
      now: 10_000 + Brain.POUNCE_MS + Brain.POUNCE_COOLDOWN_MS + 500,
      pointer: { onBar: true, pos: 500 },
      x: 492,
    }),
    soon.state,
  );
  assert.equal(eventually.reason, "pounce", "and then allow another");
});

test("pounce: switching it off keeps the cat on the ground", () => {
  const config = { ...input().config, pounce: false };
  const start = decide({ pointer: { onBar: true, pos: 500 }, x: 300, config });
  const out = Brain.decide(
    input({ pointer: { onBar: true, pos: 500 }, x: 492, config }),
    start.state,
  );
  assert.notEqual(out.reason, "pounce");
  assert.equal(out.lift, 0);
});

test("pounce: it leaps into the screen, whichever edge the bar is on", () => {
  // On a top bar the cat must leap *downwards* — up is off the screen.
  for (const [edge, axis, outward, back] of [
    ["top", "h", ["dwleft", "dwright"], ["upleft", "upright"]],
    ["bottom", "h", ["upleft", "upright"], ["dwleft", "dwright"]],
    ["left", "v", ["dwright", "upright"], ["dwleft", "upleft"]],
    ["right", "v", ["dwleft", "upleft"], ["dwright", "upright"]],
  ]) {
    const start = decide({ edge, axis, pointer: { onBar: true, pos: 500 }, x: 300 });
    const out = Brain.decide(
      input({ edge, axis, pointer: { onBar: true, pos: 500 }, x: 492 }),
      start.state,
    );
    assert.equal(out.reason, "pounce", `${edge}: should pounce`);
    assert.ok(
      outward.includes(out.pose),
      `${edge}: leaving the bar should be one of ${outward}, got ${out.pose}`,
    );
    const returning = Brain.decide(
      input({ edge, axis, now: 10_000 + Brain.POUNCE_MS * 0.75, pointer: { onBar: true, pos: 500 }, x: 492 }),
      out.state,
    );
    assert.ok(
      back.includes(returning.pose),
      `${edge}: returning should be one of ${back}, got ${returning.pose}`,
    );
  }
});

test("pounce: a pouncing cat cannot be clicked and needs ticks", () => {
  const start = decide({ pointer: { onBar: true, pos: 500 }, x: 300 });
  const out = Brain.decide(input({ pointer: { onBar: true, pos: 500 }, x: 492 }), start.state);
  assert.equal(out.pettable, false);
  assert.equal(out.idle, false);
});

test("the sleeping cat reports that it needs no ticks", () => {
  let out = decide({ now: 300_000, lastPointerMoveAt: 10_000, x: 500 });
  const chainTotal = Brain.CHAIN.reduce(
    (sum, s) => sum + (Number.isFinite(s.ms) ? s.ms : 0),
    0,
  );
  out = Brain.decide(
    input({ now: 300_000 + chainTotal + 1000, lastPointerMoveAt: 10_000, x: out.target }),
    out.state,
  );
  assert.equal(out.pose, "sleep");
  assert.equal(out.idle, true, "a sleeping cat should let the render timer stop");

  const busy = decide({ pointer: { onBar: true, pos: 900 }, x: 100 });
  assert.equal(busy.idle, false);
});
