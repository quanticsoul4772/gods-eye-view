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
]);
