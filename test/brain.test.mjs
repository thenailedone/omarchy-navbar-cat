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
  `${source}\nreturn { decide, freshState, CHAIN, PET_MS, PET_PERK_MS, AWAKE_MS, SCAMPER_MS };`,
)();

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

test("rung 4: charging drifts the cat into the right third", () => {
  const out = decide({ charging: true, x: 100 });
  assert.equal(out.reason, "charging");
  assert.ok(out.target > (BAR * 2) / 3, `expected right third, got ${out.target}`);
});

test("rung 4: charging outranks music", () => {
  const out = decide({ charging: true, music: true, x: 100 });
  assert.equal(out.reason, "charging");
});

test("rung 4: a charging cat eventually naps", () => {
  const chainTotal = Brain.CHAIN.reduce(
    (sum, step) => sum + (Number.isFinite(step.ms) ? step.ms : 0),
    0,
  );
  // Walk there, arrive, then let the settling chain run its course. The cat
  // has to actually get there first — the nap is timed from arrival, not from
  // the moment the charger went in.
  let out = decide({ charging: true, x: 100 });
  assert.equal(out.gait, "walk");
  out = Brain.decide(input({ charging: true, x: out.target }), out.state);
  assert.equal(out.pose, "stop", "settles before it sleeps");
  out = Brain.decide(
    input({ charging: true, x: out.target, now: 10_000 + chainTotal + 2000 }),
    out.state,
  );
  assert.equal(out.pose, "sleep");
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
  const out = decide({ pointer: { onBar: true, pos: 500 }, x: 500 - CAT / 2 });
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
  const out = decide({
    pointer: { onBar: true, pos: BAR + 200 },
    x: BAR - CAT,
  });
  assert.equal(out.pose, "rtogi");

  const left = decide({ pointer: { onBar: true, pos: -200 }, x: 0 });
  assert.equal(left.pose, "ltogi");
});

test("vertical bars: the cat uses up and down frames", () => {
  const down = decide({ axis: "v", pointer: { onBar: true, pos: 900 }, x: 100 });
  assert.equal(down.pose, "down");
  const up = decide({ axis: "v", pointer: { onBar: true, pos: 100 }, x: 900 });
  assert.equal(up.pose, "up");
});

test("vertical bars: edge clawing uses the top and bottom frames", () => {
  const bottom = decide({ axis: "v", pointer: { onBar: true, pos: BAR + 200 }, x: BAR - CAT });
  assert.equal(bottom.pose, "dtogi");
  const top = decide({ axis: "v", pointer: { onBar: true, pos: -200 }, x: 0 });
  assert.equal(top.pose, "utogi");
});

test("petting is only offered while the cat is settled", () => {
  const moving = decide({ pointer: { onBar: true, pos: 900 }, x: 100 });
  assert.equal(moving.pettable, false, "a walking cat must not hold an input region");

  const settled = decide({ pointer: { onBar: true, pos: 500 }, x: 500 - CAT / 2 });
  assert.equal(settled.pettable, true);
});

test("petting is never offered when the user has switched it off", () => {
  const out = decide({
    pointer: { onBar: true, pos: 500 },
    x: 500 - CAT / 2,
    config: { ...input().config, pettable: false },
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
