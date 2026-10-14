# Performance test strategy

How performance is measured on this fork, how a change is judged, and which
gate catches which kind of regression. Baselines live in `bench/baselines/`;
the findings and ranked work list are a local report
(`claudedocs/perf-plan_2026-10-13.md`, not in git).

## What users feel, and the metric for each

| Experience            | Metric                                                                              | Where                                                 |
| --------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Opening the app       | app ready, tiles loaded, settled (ms); download MiB and requests; heap after start  | `qa-bench` startup                                    |
| Panning and orbiting  | Cesium ticks/s while the camera moves (60 = smooth), frame-time p95, long tasks     | `qa-bench` motion windows                             |
| A parked view         | renders/s at rest (0 when nothing moves; ~12 with aircraft, by design), script ms/s | `qa-bench` rest windows, `qa-perf`, `qa-paced-render` |
| Turning a layer on    | ms until enabled and until first data; object count                                 | `qa-bench` layers                                     |
| Memory over a session | heap while a layer is on, and heap still held after it is turned off                | `qa-bench` layers (`heapDeltaMiB`, `retainedMiB`)     |
| Asking the assistant  | seconds, model round trips, input tokens per question                               | `qa-ask-live`                                         |

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
- Keyed sources (FIRMS, AISStream, TomTom), whose populations are the largest.
- A deterministic aircraft fixture: detection and flights measure a live
  population, so their numbers move with traffic.
- GPU time per frame (WebGL timer queries are not exposed here); frame time is
  measured from the main thread.
