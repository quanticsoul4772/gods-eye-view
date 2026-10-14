/**
 * Prompt corpus for scripts/qa-ask-live.mjs: real Ask Claude turns against
 * the real app. Each entry:
 *   id       short stable name (report rows, --only)
 *   prompt   what is typed into the composer
 *   start    optional camera before the turn: { lat, lon, height, pitch }
 *   checks   optional machine checks, all must hold:
 *     tools        every listed tool is called at least once
 *     noTools      none of the listed tools is called
 *     answer       regex the final answer must match
 *     answerNot    regex the final answer must not match
 *     cameraNear   { lat, lon, km } the camera ends within km of the point
 *     layersOn     layer ids enabled at the end
 *     layersOff    layer ids that must NOT be enabled at the end
 *     hudLayout    the HUD layout at the end
 *     maxRounds    at most this many /api/claude/ask round trips
 *
 * Checks catch regressions; the report is still read by a person (or a
 * model) for answers that are wrong in ways a regex cannot see.
 */

const LONDON = { lat: 51.507, lon: -0.128, height: 3000, pitch: -50 };
const DUBAI = { lat: 25.112, lon: 55.139, height: 2400, pitch: -50 };
const DOWNTOWN_DUBAI = { lat: 25.1972, lon: 55.2744, height: 1500, pitch: -45 };
const SHIBUYA = { lat: 35.6595, lon: 139.7005, height: 250, pitch: -60 };
const MONGOLIAN_STEPPE = { lat: 46.5, lon: 104.0, height: 1500, pitch: -60 };

export const PROMPTS = Object.freeze([
  // — the HUD layout by voice —
  {
    id: 'hud-professional-roundtrip',
    prompt:
      'Switch to the professional layout, then back to tactical, then professional again.',
    checks: { tools: ['set_hud'], hudLayout: 'professional' },
  },
  {
    id: 'hide-everything',
    prompt: 'Hide everything except the map.',
  },
  {
    id: 'what-am-i-looking-at-dubai',
    prompt: 'What am I looking at right now?',
    start: DUBAI,
    checks: { answer: /Dubai|Emirates|UAE/i, answerNot: /\bIran\b/ },
  },

  // — geography edge cases —
  {
    id: 'null-island',
    prompt: 'Fly to Null Island.',
    checks: { cameraNear: { lat: 0, lon: 0, km: 300 } },
  },
  {
    id: 'fiji-dateline',
    prompt: 'Take me to Fiji and look east across the date line.',
    checks: { cameraNear: { lat: -17.7, lon: 178.1, km: 600 } },
  },
  {
    id: 'south-pole',
    prompt: 'Fly to the South Pole station.',
    checks: { cameraNear: { lat: -90, lon: 0, km: 150 } },
  },
  { id: 'springfield', prompt: 'Go to Springfield.' },
  {
    id: 'paris-texas-then-paris',
    prompt: 'Fly to Paris, Texas, then Paris.',
    checks: { cameraNear: { lat: 48.857, lon: 2.352, km: 60 } },
  },
  {
    id: 'svalbard-midnight-sun',
    prompt: 'Show me Svalbard at midnight sun.',
    checks: { cameraNear: { lat: 78.2, lon: 15.6, km: 500 } },
  },
  {
    id: 'gibraltar-overhead',
    prompt: 'Frame the Strait of Gibraltar from overhead.',
    checks: { cameraNear: { lat: 35.97, lon: -5.6, km: 80 } },
  },

  // — layers nobody turned on —
  {
    id: 'cables-marseille',
    prompt: 'Show undersea cables landing in Marseille.',
    checks: { layersOn: ['telegeography-submarine-cables'] },
  },
  {
    id: 'datacenters-ashburn',
    prompt: 'Where are the data centers around Ashburn, Virginia?',
    checks: { layersOn: ['local-datacenters'] },
  },
  {
    id: 'dams-colorado',
    prompt: 'Show dams on the Colorado River and fly to the biggest one.',
    checks: { layersOn: ['local-dams'] },
  },
  {
    id: 'lightning-kinshasa',
    prompt: 'Any lightning right now near Kinshasa?',
  },
  {
    id: 'fires-australia',
    prompt: 'Show active wildfires and their perimeters in Australia.',
  },
  {
    id: 'cyclones-strongest',
    prompt: 'Are there any tropical cyclones? Take me to the strongest.',
  },
  {
    id: 'imagery-kyiv',
    prompt: 'Show recent satellite imagery over Kyiv.',
  },
  {
    id: 'transit-tokyo-bikes-paris',
    prompt: 'Turn on transit in Tokyo and bikeshare in Paris.',
    checks: { layersOn: ['transit', 'bikeshare'] },
  },

  // — sky —
  {
    id: 'iss-reykjavik',
    prompt: 'When can I next see the ISS from Reykjavík?',
    // The pass tool loads the satellite catalog itself (no enable-and-retry).
    checks: { tools: ['next_iss_pass'], maxRounds: 2 },
  },
  {
    id: 'hubble-nairobi',
    prompt: 'When does Hubble pass over Nairobi?',
    checks: { tools: ['next_satellite_pass'], maxRounds: 2 },
  },
  {
    id: 'launches',
    prompt: 'Show rocket launches this month and fly to the next launch site.',
    checks: { layersOn: ['rocket-launches'] },
  },

  // — tracking and multi-step —
  {
    id: 'track-handoff',
    prompt:
      'Track the nearest plane, then hand off to whichever plane passes closest to it.',
    start: LONDON,
  },
  {
    id: 'route-iberia',
    prompt: 'Fly the route Lisbon → Madrid → Barcelona at 3,000 m.',
    checks: { tools: ['fly_route'] },
  },
  {
    id: 'military-cockpit',
    prompt:
      'Follow a military aircraft, switch to cockpit view, then stop tracking.',
  },
  {
    id: 'quakes-annotate',
    prompt: 'Mark every earthquake above magnitude 5 today and label them.',
  },

  // — ambiguous, contradictory, adversarial —
  {
    id: 'everything-on',
    prompt: 'Turn everything on.',
    // Space Missions is a mode that switches live layers off; a bulk request
    // must leave it out rather than end up with three layers on.
    checks: {
      layersOn: ['flights', 'earthquakes', 'local-datacenters'],
      layersOff: ['rocket-launches'],
    },
  },
  {
    id: 'flights-not-over-water',
    prompt: 'Show me flights but not over water.',
  },
  {
    id: 'real-spy-satellite',
    prompt: 'Make it look like a real spy satellite.',
  },
  {
    id: 'license-plate',
    prompt: 'Zoom in until you can read a license plate.',
    start: LONDON,
  },
  {
    id: 'gsd-car',
    prompt: "What's the GSD right now, and is that good enough to see a car?",
    start: LONDON,
    // The HUD's GSD is in get_current_view_state's readouts.
    checks: { answerNot: /can.?t read (a|the) GSD|cannot read (a|the) GSD/i },
  },

  // ── Keyed sources (2026-10-14: AISStream, FIRMS, TomTom, Google, Mapillary,
  // Cesium ion). Without the key these turn into honest-refusal checks. ──

  // — ships (AISStream) —
  {
    id: 'ships-hormuz-count',
    prompt: 'How many ships are in the Strait of Hormuz right now?',
    checks: { layersOn: ['ais-live-vessels'], answer: /\d/ },
  },
  {
    id: 'ships-largest-singapore',
    prompt: 'Track the largest container ship near Singapore.',
  },
  {
    id: 'ships-to-rotterdam',
    prompt: 'Which tankers are heading to Rotterdam?',
  },
  {
    id: 'ships-stopped-somalia',
    prompt: 'Show vessels that have stopped moving off the coast of Somalia.',
  },

  // — fires (NASA FIRMS) —
  {
    id: 'fires-brazil-biggest',
    prompt: 'Where are the biggest fires burning in Brazil today?',
    checks: { answerNot: /no (FIRMS )?key|not configured/i },
  },
  {
    id: 'fires-near-la',
    prompt: 'Are there any fires within 50 km of Los Angeles?',
    checks: { answerNot: /no (FIRMS )?key|not configured/i },
  },
  { id: 'fires-yellowknife', prompt: 'Show fires near Yellowknife.' },

  // — traffic (TomTom) —
  {
    id: 'traffic-istanbul',
    prompt: 'How bad is traffic in Istanbul right now?',
    checks: { cameraNear: { lat: 41.01, lon: 28.98, km: 80 } },
  },
  {
    id: 'traffic-london-worst',
    prompt: 'Fly over the worst traffic jam in London.',
    checks: { cameraNear: { lat: 51.507, lon: -0.128, km: 60 } },
  },

  // — Google 3D and place search —
  {
    id: 'burj-street-level',
    prompt: 'Show me the Burj Khalifa from street level.',
    checks: { cameraNear: { lat: 25.1972, lon: 55.2744, km: 3 } },
  },
  {
    id: 'tallest-building-in-view',
    prompt: "What's the tallest building I'm looking at?",
    start: DOWNTOWN_DUBAI,
  },
  {
    id: 'nearest-hospital',
    prompt: 'Find the nearest hospital to the view centre.',
    start: LONDON,
  },
  {
    id: 'what-street-tokyo',
    prompt: 'What street is this?',
    start: SHIBUYA,
    checks: { answerNot: /\bIran\b/ },
  },

  // — street-level imagery (Mapillary) —
  {
    id: 'street-photos-reykjavik',
    prompt: "Show me street-level photos of Reykjavík's main street.",
    checks: { cameraNear: { lat: 64.146, lon: -21.94, km: 15 } },
  },
  {
    id: 'street-imagery-rural',
    prompt: 'Is there street imagery for this spot?',
    start: MONGOLIAN_STEPPE,
  },

  // — mixing layers and modes —
  {
    id: 'ships-and-fires-greece',
    prompt: 'Show me ships and fires along the coast of Greece.',
    checks: { layersOn: ['ais-live-vessels', 'local-firms'] },
  },
  {
    id: 'air-traffic-london-vs-paris',
    prompt: 'Compare air traffic over London and Paris.',
    checks: { answer: /London[\s\S]*Paris|Paris[\s\S]*London/i },
  },
  {
    id: 'bing-then-3d',
    prompt: 'Switch to the Bing aerial map, then back to 3D.',
    checks: { tools: ['set_map_stack'] },
  },
  {
    id: 'everything-then-moving',
    prompt: "Turn on everything, then show me only what's moving.",
    checks: { layersOff: ['rocket-launches'] },
  },

  // — edge cases and pushback —
  {
    id: 'ship-near-titanic',
    prompt: 'Follow the ship closest to the Titanic wreck site.',
  },
  {
    id: 'fire-exact-pixel',
    prompt: 'Zoom to the exact pixel where a fire is.',
  },
  {
    // A ship with AIS off sends nothing, so the app cannot show it.
    id: 'ships-ais-off',
    prompt: 'Show me ships with their AIS turned off.',
  },
  {
    // TomTom has no coverage there; the answer must not invent conditions.
    id: 'traffic-pyongyang',
    prompt: "What's the traffic like in Pyongyang?",
  },
  {
    id: 'no-3d-coverage',
    prompt: 'Find a building with no Google 3D coverage.',
  },
]);
