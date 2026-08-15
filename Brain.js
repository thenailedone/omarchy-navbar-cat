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
// How long a pounce takes from crouch to landing.
var POUNCE_MS = 600
// And how long before it may pounce again, so batting at the pointer stays
// playful rather than becoming a twitch.
var POUNCE_COOLDOWN_MS = 6000
// How far along the bar a pounce carries the cat.
var POUNCE_REACH = 14

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
    // Sleep is not a dead end: a sleeping cat schedules its own next stir, gets
    // up, potters about, and settles again.
    nextStirAt: null,
    stirUntil: null,
    // Which way the cat last travelled, so a pounce has a direction to go in
    // even though it launches from a standstill.
    lastDir: 1,
    pounceStartedAt: null,
    pounceFrom: 0,
    lastPounceAt: null,
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

  // A sleeping cat gets up now and then, potters about, and settles again.
  // This sits above the rungs that can end in sleep rather than inside one of
  // them, because the cat can nod off for more than one reason — on AC power as
  // well as from plain idleness — and it should rouse itself from any of them.
  // It can only fire when a stir is actually booked, and a stir is only ever
  // booked by falling asleep.
  if (state.stirUntil !== null && state.stirUntil !== undefined) {
    if (now < state.stirUntil) {
      if (state.wanderTarget === null || state.wanderTarget === undefined) {
        state.wanderTarget = nextRandom(state) * maxX
      }
      return { reason: "stir", target: state.wanderTarget, gait: "walk", rest: "chain" }
    }
    state.stirUntil = null
    state.wanderTarget = null
  }
  if (state.nextStirAt !== null && state.nextStirAt !== undefined
      && now >= state.nextStirAt) {
    state.nextStirAt = null
    state.stirUntil = now + (config.stirFor || 25) * 1000
    state.wanderTarget = nextRandom(state) * maxX
    return { reason: "stir", target: state.wanderTarget, gait: "walk", rest: "chain" }
  }

  // 4. On AC power — get drowsy, and sleep wherever it happens to be.
  //
  //    This used to march the cat to the right third of the bar, on the theory
  //    that it was napping by the power widget. In practice it meant the cat
  //    always slept in the same spot, and worse, that a cat which had stirred
  //    and wandered off would trudge all the way back before settling. Cats
  //    sleep where they are.
  if (reactions.charging !== false && input.charging) {
    return {
      reason: "charging",
      target: input.x,
      gait: "idle",
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

// The frame for a diagonal leap. Which diagonal depends on the edge the bar is
// docked to, because "out of the bar" means down on a top bar and up on a
// bottom one — leaping the wrong way would take the cat off the screen.
//
//   alongDir  which way it is facing down the length of the bar (-1 / +1)
//   outward   +1 while leaving the bar, -1 while dropping back into it
function leapPose(edge, alongDir, outward) {
  var dx, dy
  if (edge === "left" || edge === "right") {
    dy = alongDir
    dx = edge === "left" ? outward : -outward
  } else {
    dx = alongDir
    dy = edge === "top" ? outward : -outward
  }
  if (dy < 0) return dx < 0 ? "upleft" : "upright"
  return dx < 0 ? "dwleft" : "dwright"
}

function decide(input, state) {
  state = state || freshState()
  var maxX = Math.max(0, input.barLength - input.catSize)
  var vertical = input.axis === "v"
  var edge = input.edge || (vertical ? "left" : "top")
  var now = input.now

  var want = intent(input, state)
  var rawTarget = want.target
  var target = clamp(rawTarget, 0, maxX)
  var delta = target - input.x
  var moving = want.gait !== "idle" && Math.abs(delta) > ARRIVE_EPS

  // Reaching the pointer is the cue to pounce at it. Anything else the cat is
  // doing takes priority, and the cooldown keeps it from turning into a tic.
  var config = input.config || {}
  var pouncing = state.pounceStartedAt !== null && state.pounceStartedAt !== undefined
  if (!pouncing && config.pounce !== false && want.reason === "chase" && !moving
      && (state.lastPounceAt === null || state.lastPounceAt === undefined
          || now - state.lastPounceAt >= POUNCE_COOLDOWN_MS)) {
    state.pounceStartedAt = now
    state.pounceFrom = input.x
    pouncing = true
  }
  if (pouncing) {
    var progress = (now - state.pounceStartedAt) / POUNCE_MS
    if (progress >= 1) {
      state.pounceStartedAt = null
      state.lastPounceAt = now
    } else {
      // A half-sine arc: off the ground, over, and back down.
      var leapTarget = clamp(
        state.pounceFrom + state.lastDir * POUNCE_REACH * progress, 0, maxX)
      state.pose = leapPose(edge, state.lastDir, progress < 0.5 ? 1 : -1)
      return {
        reason: "pounce",
        target: leapTarget,
        gait: "run",
        pose: state.pose,
        lift: Math.sin(Math.PI * progress),
        // The arc is described exactly rather than chased, so the body should
        // place the cat where it is told instead of easing toward it.
        snap: true,
        bob: false,
        pettable: false,
        idle: false,
        wakeIn: 0,
        state: state,
      }
    }
  }

  // A stir schedule belongs to the states that can end in sleep. If the cat is
  // up for a real reason — chased, petted, startled — drop it, so it does not
  // fire the moment the cat next settles.
  if (!want.sleepy && want.reason !== "stir") {
    state.nextStirAt = null
    state.stirUntil = null
  }

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
        lift: 0, snap: false, bob: false, pettable: false, idle: false,
        wakeIn: 0, state: state,
      }
    } else {
      state.wokeAt = null
    }
  }

  if (moving) {
    state.restKey = null
    state.restStartedAt = null
    state.lastDir = delta > 0 ? 1 : -1
    state.pose = vertical
      ? (delta > 0 ? "down" : "up")
      : (delta > 0 ? "right" : "left")
    return {
      reason: want.reason, target: target, gait: want.gait, pose: state.pose,
      lift: 0, snap: false, bob: false, pettable: false, idle: false,
      wakeIn: 0, state: state,
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

  // A cat that has just dropped off books its own next stir. Without this it
  // would sleep until the pointer moved, which on an unattended machine means
  // forever.
  if (pose === "sleep"
      && (state.nextStirAt === null || state.nextStirAt === undefined)) {
    var average = (config.stirEvery || 150) * 1000
    state.nextStirAt = now + average * (0.6 + 0.8 * nextRandom(state))
  }

  return {
    reason: want.reason,
    target: target,
    gait: "idle",
    pose: pose,
    lift: 0,
    snap: false,
    bob: want.bob === true,
    pettable: config.pettable !== false,
    idle: pose === "sleep",
    // How long the body may stop ticking for. Only meaningful while asleep.
    wakeIn: pose === "sleep" ? Math.max(0, state.nextStirAt - now) : 0,
    state: state,
  }
}
