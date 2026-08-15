// The cat's behaviour core.
//
// This file is deliberately pure: it holds no QML, touches nothing outside its
// arguments, and reads no clock of its own. `decide()` takes a snapshot of the
// world plus the cat's own carried-over state and returns what the cat should
// be doing. Everything that makes the cat feel alive is decided here, so it can
// all be tested with a fake clock — see test/brain.test.mjs.
//
// The idle behaviour is transcribed from oneko's own state machine
// (oneko.c:1107): a cat left alone sits, washes its face, scratches its head,
// yawns, and only then sleeps; any reason to move first plays a wake frame.
// Keeping that sequence is what makes this read as *the* cat rather than a
// sprite sliding around.

// How long a petted cat stays pleased.
var PET_MS = 4000
// A petted cat looks up first and only then starts grooming. Without this beat
// it begins washing on the same frame as the click, which reads as the cat
// ignoring you rather than responding to you.
var PET_PERK_MS = 450
// The pause between opening its eyes and actually setting off.
var AWAKE_MS = 500
// How long a workspace switch keeps startling the cat.
var SCAMPER_MS = 1200
// How far a startled cat bolts.
var SCAMPER_DISTANCE = 160
// Close enough to count as arrived.
var ARRIVE_EPS = 2

// The settling sequence, in order. `Infinity` terminates it.
var CHAIN = [
  { pose: "stop", ms: 1200 },
  { pose: "wash", ms: 3000 },
  { pose: "scratch", ms: 1600 },
  { pose: "yawn", ms: 1800 },
  { pose: "sleep", ms: Infinity },
]

// Poses the cat can be roused from. `awake` is excluded: it is the rousing
// itself, and treating it as rest would restart the wake pause every tick.
var RESTING = { stop: 1, wash: 1, scratch: 1, yawn: 1, sleep: 1 }

function freshState(seed) {
  return {
    seed: seed === undefined ? 987654321 : seed,
    pose: null,
    wokeAt: null,
    restKey: null,
    restStartedAt: null,
    wanderTarget: null,
  }
}

// A small LCG, so the cat's wandering is deterministic for a given seed. Using
// Math.random() here would make the wander tests unreproducible.
function nextRandom(state) {
  state.seed = (state.seed * 1103515245 + 12345) % 2147483648
  return state.seed / 2147483648
}

function clamp(value, low, high) {
  if (value < low) return low
  if (value > high) return high
  return value
}

function chainPose(elapsed) {
  var acc = 0
  for (var i = 0; i < CHAIN.length; i++) {
    if (!isFinite(CHAIN[i].ms)) return CHAIN[i].pose
    acc += CHAIN[i].ms
    if (elapsed < acc) return CHAIN[i].pose
  }
  return CHAIN[CHAIN.length - 1].pose
}

// Total time to walk the chain down to, but not including, sleep.
function chainWakingTotal() {
  var acc = 0
  for (var i = 0; i < CHAIN.length; i++) {
    if (!isFinite(CHAIN[i].ms)) break
    acc += CHAIN[i].ms
  }
  return acc
}

// Which rung of the ladder applies. Returns the cat's intent, before any
// clamping to the bar or any decision about what it should look like.
//
//   rest: "hold"  stay exactly here
//         "wait"  sit here, stay awake
//         "chain" run the settling sequence, sleeping at the end if `sleepy`
function intent(input, state) {
  var config = input.config || {}
  var reactions = config.reactions || {}
  var maxX = Math.max(0, input.barLength - input.catSize)
  var now = input.now

  // 1. Just petted.
  if (input.pettedAt !== null && input.pettedAt !== undefined
      && now - input.pettedAt < PET_MS) {
    var sincePet = now - input.pettedAt
    return {
      reason: "petted",
      target: input.x,
      gait: "idle",
      rest: "hold",
      pose: sincePet < PET_PERK_MS ? "awake" : "wash",
    }
  }

  // 2. Pointer on the bar.
  if (config.chaseCursor !== false && input.pointer && input.pointer.onBar) {
    return {
      reason: "chase",
      target: input.pointer.pos - input.catSize / 2,
      gait: "run",
      rest: "wait",
    }
  }

  // 3. Workspace switched a moment ago.
  if (reactions.workspace !== false && input.workspaceEvent
      && now - input.workspaceEvent.at < SCAMPER_MS) {
    return {
      reason: "workspace",
      target: input.x + input.workspaceEvent.dir * SCAMPER_DISTANCE,
      gait: "run",
      rest: "wait",
    }
  }

  // 4. On AC power — settle down in the right third, near where the power
  //    widget conventionally sits. Section aiming: the bar exposes no widget
  //    geometry, so this is a third of the bar, not an exact icon.
  if (reactions.charging !== false && input.charging) {
    return {
      reason: "charging",
      target: input.barLength * (5 / 6) - input.catSize / 2,
      gait: "walk",
      rest: "chain",
      sleepy: true,
    }
  }

  // 5. Something is playing — drift to the centre and bob.
  if (reactions.music !== false && input.music) {
    return {
      reason: "music",
      target: maxX / 2,
      gait: "walk",
      rest: "wait",
      bob: true,
    }
  }

  // 6. Nobody has touched the pointer in a long while.
  if (now - input.lastPointerMoveAt > (config.sleepAfter || 180) * 1000) {
    return {
      reason: "idle-sleep",
      target: input.x,
      gait: "idle",
      rest: "chain",
      sleepy: true,
    }
  }

  // 7. Nothing in particular. Wander, and re-roll once the cat has finished
  //    dawdling wherever it arrived.
  if (state.wanderTarget === null || state.wanderTarget === undefined) {
    state.wanderTarget = nextRandom(state) * maxX
  }
  return { reason: "wander", target: state.wanderTarget, gait: "walk", rest: "chain" }
}

function decide(input, state) {
  state = state || freshState()
  var maxX = Math.max(0, input.barLength - input.catSize)
  var vertical = input.axis === "v"
  var now = input.now

  var want = intent(input, state)
  var rawTarget = want.target
  var target = clamp(rawTarget, 0, maxX)
  var delta = target - input.x
  var moving = want.gait !== "idle" && Math.abs(delta) > ARRIVE_EPS

  // Rouse the cat before it moves, the way oneko does.
  if (moving && RESTING[state.pose] && (state.wokeAt === null || state.wokeAt === undefined)) {
    state.wokeAt = now
  }
  if (state.wokeAt !== null && state.wokeAt !== undefined) {
    if (!moving) {
      state.wokeAt = null
    } else if (now - state.wokeAt < AWAKE_MS) {
      state.pose = "awake"
      return {
        reason: want.reason, target: target, gait: "idle", pose: "awake",
        bob: false, pettable: false, idle: false, state: state,
      }
    } else {
      state.wokeAt = null
    }
  }

  if (moving) {
    state.restKey = null
    state.restStartedAt = null
    state.pose = vertical
      ? (delta > 0 ? "down" : "up")
      : (delta > 0 ? "right" : "left")
    return {
      reason: want.reason, target: target, gait: want.gait, pose: state.pose,
      bob: false, pettable: false, idle: false, state: state,
    }
  }

  // Settled. Start (or continue) whatever the cat does while standing still.
  var restKey = want.reason + ":" + Math.round(target)
  if (state.restKey !== restKey) {
    state.restKey = restKey
    state.restStartedAt = now
  }
  var elapsed = now - state.restStartedAt

  var pose
  if (want.rest === "hold") {
    pose = want.pose || "stop"
  } else if (want.rest === "wait") {
    pose = "stop"
  } else {
    pose = chainPose(elapsed)
    if (!want.sleepy && pose === "sleep") {
      // A cat that is merely idle, not tired, gets bored and moves on rather
      // than dropping off — sleep is rung 6's job.
      state.wanderTarget = null
      state.restKey = null
      state.restStartedAt = null
      pose = "stop"
    }
  }

  // Wanting to walk off the end of the bar becomes clawing at it instead.
  if (rawTarget > maxX + ARRIVE_EPS) {
    pose = vertical ? "dtogi" : "rtogi"
  } else if (rawTarget < -ARRIVE_EPS) {
    pose = vertical ? "utogi" : "ltogi"
  }

  state.pose = pose
  return {
    reason: want.reason,
    target: target,
    gait: "idle",
    pose: pose,
    bob: want.bob === true,
    pettable: (input.config || {}).pettable !== false,
    idle: pose === "sleep",
    state: state,
  }
}
