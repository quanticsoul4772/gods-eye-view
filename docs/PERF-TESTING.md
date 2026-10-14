# Performance test strategy

How performance is measured on this fork, how a change is judged, and which
gate catches which kind of regression. Baselines live in `bench/baselines/`;
the findings and ranked work list are a local report
(`claudedocs/perf-plan_2026-10-13.md`, not in git).

## What users feel, and the metric for each

| Experience            | Metric                                                                                        | Where                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Opening the app       | app ready, tiles loaded, settled (ms); download MiB and requests; heap after start            | `qa-bench` startup                                                     |
| Panning and orbiting  | Cesium ticks/s while the camera moves (60 = smooth), frame-time p95, long tasks               | `qa-bench` motion windows                                              |
| A parked view         | renders/s at rest (0 when nothing moves; ~12 with aircraft, by design), script ms/s           | `qa-bench` rest windows, `qa-perf`, `qa-paced-render`                  |
| Turning a layer on    | ms until enabled and until first data; object count                                           | `qa-bench` layers                                                      |
| Memory over a session | heap while a layer is on, heap still held after it is turned off, growth over repeated on/off | `qa-bench` layers (`heapDeltaMiB`, `retainedMiB`), leaks (`growthMiB`) |
| Asking the assistant  | seconds, model round trips, input tokens per question                                         | `qa-ask-live`                                                          |

`fps` in `qa-bench` is Cesium's render-loop tick rate. Headless `requestAnimationFrame`
is not tied to a 60 Hz display (it read 84/s at idle), so it is kept only as
`rafFps`. At rest, compare `rendersPerSec` and `scriptMsPerSec`, not fps: a
parked scene that is working correctly draws nothing.

## Tiers

1. **Unit (every `npm test`).** Deterministic work counters, not timings:
   render-governor modes and request counts, detection's placement builds per
   solve, fleet step alignment. A timing in a unit test is flaky; a count of
   work done per frame is not.
2. **Relative browser gates (any machine, SwiftShader is fine).** `qa-perf`
   (governor contract: idle draws nothing, paced draws on the fleet step) and
   `qa-paced-render`. They compare frame counts between conditions in one run,
   so the GPU does not matter.
3. **Absolute benchmark (`qa-bench`, real GPU, one fixed machine).** Every
   scenario family against a saved baseline with thresholds. Run before and
   after any performance change, and before merging anything that touches
   rendering, detection, layers or startup.
4. **End to end (`qa-ask-live`).** Real Ask Claude turns, for latency and round
   trips per question. Spends API credit, so run it for assistant changes only.

## Benchmark controls (`qa-bench`)

- **Production build, not the dev server.** The dev server serves ~1,300
  unbundled modules (64 MiB, 63 MiB heap at start); the build serves ~500
  requests (18 MiB, 27 MiB heap). Run `npm run build`, then
  `npx vite preview --port 4180 --strictPort`, and point `QA_BASE_URL` at it.
  Results record `conditions.server`.
- **Real GPU.** The harness refuses a software renderer unless
  `--allow-software` is passed (then the numbers are relative only).
- **A frame clock that does not depend on the display.** Headless Chrome on
  Windows paces frames from the compositor's vsync; when the display sleeps
  that drops to ~10 Hz, and a whole run read 7–9 fps (a blank page: 10 rAF/s).
  The harness launches with `--disable-gpu-vsync --disable-frame-rate-limit`,
  which helped (53 rAF/s with the display just asleep) but not for long: later
  in the same sleep the blank page got 40–43. So **keep the display awake**
  during a run; the harness refuses to measure when a blank page gets fewer
  than 50 frames/s. Cesium still caps its loop at 60, so `fps` keeps its
  meaning. Disable display sleep for the session (Windows: Settings → Power →
  screen off "Never", or `powercfg /change monitor-timeout-ac 0`).
- **A fresh page per scenario.** Layers keep memory after they are turned off,
  so one page carried state forward: styles measured at 22 fps after the layer
  runs and 53–60 fps on a fresh page.
- **Warm-up before measuring.** An unmeasured 3 s camera turn, then tiles. The
  first scene after a camera move otherwise measured at half speed.
- **Medians of repeated windows** (`--reps`, default 2) for rest and motion.
- **Defaults as a new user has them**, plus controls: each layer also records a
  detection-off motion window, and the detection scenario includes `off`.
- **Live counts with every number.** Feeds change: the flights scenario saw
  11,992 aircraft in one run and 627 in the next (the global feed did not
  arrive), and ran at 30 and 60 fps respectively. Compare runs only when the
  counts match; a source outage is missing coverage, not a speed-up.
- **Main-thread time from profiles.** CDP `ScriptDuration` read ~790 ms/s while
  the CPU profile of the same window showed the main thread half idle: it
  includes Cesium's worker threads. Judge main-thread load by the profile's
  idle share and by long tasks.
- **Same machine, same conditions.** 1440×900 at DPR 1, focused headless
  page, park over Austin at 60 km.

## Basemap and keys

With a Google Maps key the app opens on Google's photorealistic 3D tiles
(map stack `photoreal`) instead of keyless Esri imagery, and everything costs
more: startup 58 vs 18 MiB downloaded, heap 119 vs 27 MiB, idle script 76 vs
17 ms/s, normal-style motion 24 vs 60 fps. Keep one baseline per basemap
(`arc-win11-build` is Esri, keyless; `arc-win11-build-google3d` is photoreal
with keys) and pass `--basemap <stack>` to measure on a chosen one. The Google
key is baked into the build at build time (`build/vite.js`), so rebuild after
adding it.

On photoreal, per-layer `heapDeltaMiB` / `retainedMiB` include 30–45 MiB of 3D
tile cache filled during the camera moves (Bikeshare, with no data, read
31 MiB); judge layer memory on the Esri baseline, and leaks by `growthMiB` on
either.

## Run-to-run noise (measured)

Two identical runs on the Arc baseline machine, same conditions:

| Metric family                                            | Repeat spread                                        | Gate in `--compare`                  |
| -------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Heap while on, heap kept after off, startup heap         | within ~5 % (datacenters +149.3 / +149.8 MiB)        | +10 % / +15 % retained               |
| Startup timings and bytes                                | within ~5 % (ready 872 / 872 ms, 18.2 / 18.3 MiB)    | +15 % (+10 % bytes)                  |
| fps, heavy scenes (flights ~12k, cables, CCTV, combined) | ~15–25 % (flights 30.4 / 30.6, combined 11.3 / 14.5) | −25 %                                |
| fps, mid-weight scenes (datacenters, satellites, dams)   | **bimodal**: 30 vs 59 fps                            | flag only; confirm with a second run |
| Layer activation                                         | 2–4× (CCTV 4.3–15.5 s): it measures the network      | reported, not gated                  |

A single run can therefore judge memory, startup and the heavy scenes. A
mid-weight fps change needs two runs that agree, and activation needs recorded
fixtures before it can be judged at all.

## Memory a layer keeps when it is off

Two different things show up as heap kept after a layer is turned off:

- **A leak grows with every on/off cycle.** Cesium kept a removed layer's
  draw commands (and every entity behind them) in reused per-pass arrays;
  `src/sceneCommandRelease.js` trims them. Datacenters kept 111 MiB before it,
  8.7 after; cables 70 → 5.3; dams 26 → 4.9.
- **A keep-warm cache stays flat.** CCTV (catalog and billboards, ~21–25 MiB),
  Radio (stations, ~13), Space Missions (~13–14) and Flights (~18–19) hide
  their data instead of discarding it, so turning them back on skips a
  refetch. Measured flat across three cycles; kept by design (2026-10-13).

`qa-bench --only leaks` runs three on/off cycles per layer and fails when
growth from cycle 1 to 3 exceeds 3 MiB, whatever the baseline says. To see
what a layer keeps, or what grows, use
`node scripts/qa-heap-diff.mjs --layer <id> [--warm-cycles 1 --cycles 2]`.

## Overlay cost (`qa-detection-cost`)

Detection's cost on Google 3D is GPU contention: its JS takes 0.5–4 ms per
frame, but compositing a full-screen overlay while the GPU is already the
limit costs a few renders/s out of ~50. `qa-bench` (single windows over
Austin, −25 % gate) cannot see that, so `npm run qa:detection-cost` measures it
as paired, same-session comparisons where detection is dense (vessels over
the Channel):

- **Same session, A,B,B,A.** Variants (`off`, `on`, `filter=<css>`, `frozen`)
  and targets (two servers, e.g. builds before and after a change on two
  preview ports) alternate in one browser; round 2 runs the list reversed, so
  linear drift cancels. The page not being measured has its render loop
  stopped; the measured one is brought to the front (a background tab gets
  no animation frames).
- **Noise floor first.** `--variants A:on,A:on` is an A/A run; on the Arc it
  gave ±1 renders/s. Pass it as `--noise-floor`; a claim needs twice that.
- **Result = paired deltas.** Each target's on-minus-off cost per round, and
  how that cost changed between targets. Windows more than 20 % from their
  variant's median are listed as outliers and left out: about one window in
  ten on the Arc lands in a second state (~33 instead of ~45–53 renders/s).
- **Fixed content.** Only the target layer on, camera placed before every
  window, 3D tiles loaded and still loaded a second later, detection's fade
  done; observations and labels are recorded per window.
- **Scenarios.** `still` (clock paused, every tick rendered: the mechanism),
  `live` (the feed's own render demand: what a user sees), `orbit` (camera
  moving: judge only "no regression"), `diag` (detection's own `paintMs` by
  density, per basemap, e.g. `--basemaps esri-imagery,photoreal`).
- **Frame clock.** Display vsync only. `--uncapped` exists for a sleeping
  display but changes how Chrome composites the overlay (detection cost ~2
  instead of ~9 renders/s), so it cannot judge overlay cost. A laptop panel
  with dynamic refresh rate jumps to 63–77 rAF/s under activity; runs taken
  then are noisy, so measure with the machine otherwise idle.
- **Vessel feed start.** A freshly started preview server sometimes loads no
  vessels within the harness's 90 s wait (it then stops with "loaded
  nothing"); the same server worked minutes later. Start servers a few
  minutes before measuring.

Not a detection source: FIRMS fires (`firms/queries.js` exposes
`getDetectableObjects`, but it is not registered), so FIRMS over Brazil
measures detection with nothing to draw.

## Judging a change

1. Know the noise (above). A threshold below twice the noise is noise; re-measure
   it when the machine, browser or GPU driver changes.
2. Form a hypothesis from a profile (`qa-bench --profile`, then
   `node scripts/qa-bench-profile-top.mjs <file>.cpuprofile`), not from reading.
   For memory a layer keeps after it is off, `node scripts/qa-heap-diff.mjs
--layer <id>` (dev server, for readable names) prints what grew between
   snapshots taken before and after, and saves both for retainer paths in
   DevTools > Memory.
3. Change one thing. Re-run the affected scenarios with
   `--compare bench/baselines/<name>.json`.
4. Accept when the target metric moves beyond noise and nothing regresses past
   the thresholds in `qa-bench.mjs` (set from the noise table above).
5. Save a new baseline (`--save-baseline <name>`; `--only` merges into it) only
   with the change that earned it, and say so in the commit.

## What this does not cover yet

- Other GPUs and viewports: one Intel Arc baseline on Windows 11.
- Keyed sources (FIRMS, AISStream, TomTom), whose populations are the largest,
  in `qa-bench` baselines. `qa-detection-cost` covers detection over live
  vessels only.
- A deterministic aircraft fixture: detection and flights measure a live
  population, so their numbers move with traffic.
- GPU time per frame (WebGL timer queries are not exposed here); frame time is
  measured from the main thread.
