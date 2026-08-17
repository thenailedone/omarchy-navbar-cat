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
// Crossing the clock is a longer leap than a pointer pounce. The sprite moves
// into the transparent headroom while it passes the reserved centre band, so
// it never runs across the widgets themselves.
var CROSSING_MS = 850
// A new notification makes the cat look up briefly.
var NOTIFICATION_MS = 1400
// How long it scratches an end before turning back into the bar.
var EDGE_SCRATCH_MS = 700
var EDGE_RETREAT_MS = 1400
var EDGE_RETREAT_DISTANCE = 96

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
    nextZoomAt: null,
    zoomUntil: null,
    zoomTarget: null,
    edgeScratchStartedAt: null,
    edgeRetreatUntil: null,
    edgeRetreatTarget: null,
    crossingStartedAt: null,
    crossingFrom: null,
    crossingTo: null,
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

// Convert user-supplied configuration to a finite value inside a useful range.
// QML's Number() accepts values such as Infinity, which can otherwise escape
// ordinary greater-than checks and produce invalid geometry or movement.
function boundedNumber(value, fallback, low, high) {
  var number = Number(value)
  if (!isFinite(number)) return fallback
  return clamp(number, low, high)
}

// Pick somewhere for the cat to go of its own accord, keeping clear of the
// configured widget reservations.
//
// Omarchy centres the clock by default (`centerAnchor` in shell.json), so the
// middle is reliably occupied on almost every setup, while the end reservations
// cover the usual workspace and status widgets.
//
// This is a guess about layout, not knowledge of it: nothing exposes widget
// geometry. `avoidCenter` is the fraction of the bar to keep clear, and 0
// turns the whole idea off for anyone whose clock lives elsewhere.
function safeLanes(barLength, catSize, avoidCenter, avoidEdges) {
  var maxX = Math.max(0, barLength - catSize)
  var edge = barLength * Math.max(0, avoidEdges || 0)
  var halfGap = (barLength * Math.max(0, avoidCenter || 0)) / 2
  if (halfGap <= 0) {
    return maxX - edge >= edge ? [{ low: edge, high: maxX - edge }] : []
  }
  var middle = barLength / 2
  var left = { low: edge, high: middle - halfGap - catSize }
  var right = { low: middle + halfGap, high: maxX - edge }
  var lanes = []
  if (left.high >= left.low) lanes.push(left)
  if (right.high >= right.low) lanes.push(right)
  return lanes
}

function laneFor(lanes, x) {
  for (var i = 0; i < lanes.length; i++) {
    if (x >= lanes[i].low - ARRIVE_EPS && x <= lanes[i].high + ARRIVE_EPS) return i
  }
  return -1
}

// Bring a requested position to the nearest legal point. When the request is
// inside the centre reservation, prefer the lane the cat already occupies so
// cursor chasing makes it stop short instead of needlessly crossing the clock.
function safeTarget(raw, current, barLength, catSize, avoidCenter, avoidEdges) {
  var lanes = safeLanes(barLength, catSize, avoidCenter, avoidEdges)
  if (lanes.length === 0) return clamp(raw, 0, Math.max(0, barLength - catSize))
  var currentLane = laneFor(lanes, current)
  if (currentLane >= 0 && raw > lanes[currentLane].high
      && currentLane + 1 < lanes.length && raw < lanes[currentLane + 1].low) {
    return lanes[currentLane].high
  }
  var best = lanes[0].low
  var distance = Infinity
  for (var i = 0; i < lanes.length; i++) {
    var candidate = clamp(raw, lanes[i].low, lanes[i].high)
    var candidateDistance = Math.abs(raw - candidate)
    if (candidateDistance < distance) {
      best = candidate
      distance = candidateDistance
    }
  }
  return best
}

function pickSpot(state, maxX, barLength, avoid, avoidEdges) {
  if (maxX <= 0) return 0
  if (!(avoid > 0) && !(avoidEdges > 0)) return nextRandom(state) * maxX
  var lanes = safeLanes(barLength, barLength - maxX, avoid, avoidEdges || 0)
  if (lanes.length === 0) return nextRandom(state) * maxX

  var total = 0
  for (var i = 0; i < lanes.length; i++) total += lanes[i].high - lanes[i].low
  if (total <= 0) return lanes[Math.floor(nextRandom(state) * lanes.length)].low
  var roll = nextRandom(state) * total
  for (var j = 0; j < lanes.length; j++) {
    var span = lanes[j].high - lanes[j].low
    if (roll <= span) return lanes[j].low + roll
    roll -= span
  }
  return lanes[lanes.length - 1].high
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

  // 3. A fresh notification gets a quick attentive look. DND-silenced
  // notifications never reach this input because the body watches popups.
  if (reactions.notifications !== false && input.notifiedAt !== null
      && input.notifiedAt !== undefined && now - input.notifiedAt < NOTIFICATION_MS) {
    return {
      reason: "notification",
      target: input.x,
      gait: "idle",
      rest: "hold",
      pose: "awake",
    }
  }

  // 4. Workspace switched a moment ago.
  if (reactions.workspace !== false && input.workspaceEvent
      && now - input.workspaceEvent.at < SCAMPER_MS) {
    return {
      reason: "workspace",
      target: input.x + input.workspaceEvent.dir * SCAMPER_DISTANCE,
      gait: "run",
      rest: "wait",
    }
  }

  // Rare zoomies are deterministic for a given seed, so they remain testable.
  // They outrank sleepy/passive states but never interrupt direct interaction.
  if (config.zoomies !== false) {
    if (state.nextZoomAt === null || state.nextZoomAt === undefined) {
      var zoomAverage = (config.zoomEvery || 600) * 1000
      state.nextZoomAt = now + zoomAverage * (0.7 + 0.6 * nextRandom(state))
    }
    if (state.zoomUntil !== null && state.zoomUntil !== undefined) {
      if (now < state.zoomUntil) {
        return { reason: "zoomies", target: state.zoomTarget, gait: "run", rest: "wait" }
      }
      state.zoomUntil = null
      state.zoomTarget = null
      state.nextZoomAt = null
    } else if (now >= state.nextZoomAt) {
      state.zoomUntil = now + 3200
      state.zoomTarget = input.x < maxX / 2 ? maxX : 0
      return { reason: "zoomies", target: state.zoomTarget, gait: "run", rest: "wait" }
    }
  } else {
    state.nextZoomAt = null
    state.zoomUntil = null
    state.zoomTarget = null
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
        state.wanderTarget = pickSpot(state, maxX, input.barLength, config.avoidCenter, config.avoidEdges)
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
    state.wanderTarget = pickSpot(state, maxX, input.barLength, config.avoidCenter, config.avoidEdges)
    return { reason: "stir", target: state.wanderTarget, gait: "walk", rest: "chain" }
  }

  // 4. Something is playing — dance, wherever the cat happens to be.
  //
  //    This sits above the charging rung, and the ordering matters more than it
  //    looks. Charging is a *sleepy* rung: it returns and the cat nods off. Put
  //    it first and it silences every waking reaction below it, which on a
  //    laptop that lives on mains power is all of the time — the music reaction
  //    became literally unreachable. Waking behaviour beats sleeping behaviour.
  if (reactions.music !== false && input.music) {
    return {
      reason: "music",
      target: input.x,
      gait: "idle",
      rest: "wait",
      bob: true,
    }
  }

  // 5. On AC power — get drowsy, and sleep wherever it happens to be.
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
    state.wanderTarget = pickSpot(state, maxX, input.barLength, config.avoidCenter, config.avoidEdges)
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

  // After scratching an end, run a short distance back into the bar. Direct
  // interaction always wins and cancels the automatic turnaround.
  if (state.edgeRetreatUntil !== null && state.edgeRetreatUntil !== undefined) {
    if ((want.reason === "petted" || want.reason === "chase"
         || want.reason === "notification") || now >= state.edgeRetreatUntil) {
      state.edgeRetreatUntil = null
      state.edgeRetreatTarget = null
    } else {
      want = { reason: "edge-turn", target: state.edgeRetreatTarget, gait: "run", rest: "chain" }
    }
  }
  var rawTarget = want.target
  var config = input.config || {}
  var avoidance = config.avoidWidgets !== false
    && ((config.avoidCenter || 0) > 0 || (config.avoidEdges || 0) > 0)
  var target = avoidance
    ? safeTarget(rawTarget, input.x, input.barLength, input.catSize,
        config.avoidCenter, config.avoidEdges)
    : clamp(rawTarget, 0, maxX)
  var delta = target - input.x
  var moving = want.gait !== "idle" && Math.abs(delta) > ARRIVE_EPS

  // If movement changes safe lanes, leap through the window's transparent
  // headroom. This keeps the sprite off the centre widgets for the crossing.
  var lanes = avoidance
    ? safeLanes(input.barLength, input.catSize, config.avoidCenter, config.avoidEdges)
    : []
  var fromLane = laneFor(lanes, input.x)
  var toLane = laneFor(lanes, target)
  var crossing = state.crossingStartedAt !== null && state.crossingStartedAt !== undefined
  if (!crossing && moving && fromLane >= 0 && toLane >= 0 && fromLane !== toLane) {
    state.crossingStartedAt = now
    state.crossingFrom = input.x
    state.crossingTo = target
    crossing = true
  }
  if (crossing) {
    var crossingProgress = (now - state.crossingStartedAt) / CROSSING_MS
    var crossingTarget = state.crossingFrom
      + (state.crossingTo - state.crossingFrom) * Math.min(1, crossingProgress)
    state.lastDir = state.crossingTo > state.crossingFrom ? 1 : -1
    state.pose = leapPose(edge, state.lastDir, crossingProgress < 0.5 ? 1 : -1)
    if (crossingProgress >= 1) {
      state.crossingStartedAt = null
      state.crossingFrom = null
      state.crossingTo = null
    }
    return {
      reason: "crossing", target: crossingTarget, gait: "run", pose: state.pose,
      lift: crossingProgress >= 1 ? 0 : Math.sin(Math.PI * crossingProgress), snap: true,
      bob: false, pettable: false, idle: false, wakeIn: 0, state: state,
    }
  }

  // Reaching the pointer is the cue to pounce at it. Anything else the cat is
  // doing takes priority, and the cooldown keeps it from turning into a tic.
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
    state.edgeScratchStartedAt = null
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

  // Wanting to walk off the end becomes a short scratch followed by a visible
  // turn back into the bar.
  if (rawTarget > maxX + ARRIVE_EPS) {
    if (state.edgeScratchStartedAt === null || state.edgeScratchStartedAt === undefined)
      state.edgeScratchStartedAt = now
    if (now - state.edgeScratchStartedAt < EDGE_SCRATCH_MS) {
      pose = vertical ? "dtogi" : "rtogi"
    } else {
      state.edgeScratchStartedAt = null
      state.edgeRetreatUntil = now + EDGE_RETREAT_MS
      state.edgeRetreatTarget = Math.max(0, maxX - EDGE_RETREAT_DISTANCE)
      state.restKey = null
    }
  } else if (rawTarget < -ARRIVE_EPS) {
    if (state.edgeScratchStartedAt === null || state.edgeScratchStartedAt === undefined)
      state.edgeScratchStartedAt = now
    if (now - state.edgeScratchStartedAt < EDGE_SCRATCH_MS) {
      pose = vertical ? "utogi" : "ltogi"
    } else {
      state.edgeScratchStartedAt = null
      state.edgeRetreatUntil = now + EDGE_RETREAT_MS
      state.edgeRetreatTarget = Math.min(maxX, EDGE_RETREAT_DISTANCE)
      state.restKey = null
    }
  } else {
    state.edgeScratchStartedAt = null
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
