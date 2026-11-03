import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GEV_ACTION_SCHEMAS, createActionTools } from './actionSchemas.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import {
  validateArgs,
  validateCall,
} from '../../scripts/voice-bench/grade.mjs';

const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, stable(child)]),
        )
      : value;

test('the complete Realtime tool payload pins the manifest-generated layer release', () => {
  const tools = structuredClone(GEV_REALTIME_TOOLS).filter(
    (tool) => tool.name !== 'set_cyber_sonar',
  );
  // So is fly_to_location's facing direction.
  delete tools.find((tool) => tool.name === 'fly_to_location').parameters
    .properties.headingDeg;
  const digest = createHash('sha256')
    .update(JSON.stringify(stable(tools)))
    .digest('hex');
  assert.equal(
    digest,
    // Re-derived for Provider Settings and explicit Visual Presets/Scenes routing,
    // plus the deliberate direct Panel tool/target additions and voice layer manifest (generated layer enums and
    // aliases), point-and-ask (pointer sentinels, referent args) and the
    // consolidated tool wording (each policy stated once); model-facing tools
    // omit top-level anyOf (OpenAI rejects it). Contacts list routing preserves
    // requested radius and center authority in descriptions only.
    // Street Level and GNSS extend the manifest; tracked and analyst aircraft describe broadcasts.
    // Air quality (ECCC AQHI) extends the manifest.
    // Bike share's shared-vehicle aliases and fields extend the manifest hints,
    // and analyst filters spell out units and time fields.
    // A derived field list prints whole when that is shorter than "as X minus".
    // Fire perimeters add provincial fields (hectares, status, source, times).
    // Active fires add static-source fields (known solar farms and industrial sites).
    // Air sensors (Sensor.Community PM) extend the manifest.
    // Satellite lightning (lightning-eu) extends it; two self-evident ids drop alias hints.
    // Plain "air quality" routes to air-sensors (AQHI keeps Canada); hints skip the id spelled with spaces.
    // Prompt room: a rule stated twice keeps one copy; ranges and "Optional" that the schema already says are dropped.
    // rangeM says a bare coordinate is a 250 m close-up, so a storm or fire gets a fitting range.
    // Routes can be flown (mode=flying) and an area can be a circle (radiusKm).
    // Globe rotation adds one motion; visual keyhole fit and explicit
    // reset guidance/defaults update only move_camera and mode descriptions.
    // S2 GhostMaps extends the generated layer enums.
    // The Utilities panel (Directions, Draw, Import) adds one panel target.
    // Panel adds named voice targets and timeout; shared Panel/Cockpit guidance
    // is consolidated without changing either feature's arguments.
    // Snow leaves the set_visual_style enum.
    // The Operator HUD layout leaves set_hud's layout enum.
    // The layer alias hint leaves out aliases the layer id already spells.
    // Re-derived for the merge of the fork's layer and prompt changes with the above.
    '664883a2344e04561b0337b59942891faed0d148146d0f02dbb757b872936875',
  );
});

test('descriptions customize wording without changing immutable shared arguments', () => {
  const descriptions = {
    fly_to_location: {
      description: 'Navigate',
      parameters: { properties: { query: { description: 'A place' } } },
    },
  };
  const tools = createActionTools(descriptions);
  const tool = tools.find((tool) => tool.name === 'fly_to_location');
  assert.equal(tool.description, 'Navigate');
  assert.equal(tool.parameters.properties.query.description, 'A place');
  assert.equal(tool.parameters.properties.query.type, 'string');
  tool.parameters.properties.query.type = 'number';
  assert.equal(
    createActionTools()[0].parameters.properties.query.type,
    'string',
  );
  assert.throws(() => {
    GEV_ACTION_SCHEMAS[0].parameters.properties.query.type = 'number';
  }, TypeError);
  assert.equal(
    JSON.stringify(GEV_ACTION_SCHEMAS).includes('"description"'),
    false,
  );
});

test('metadata cannot add tools, fields, types or enum values', () => {
  for (const descriptions of [
    { execute_shell: { description: 'not an action' } },
    {
      fly_to_location: {
        parameters: { properties: { description: 'new field' } },
      },
    },
    { fly_to_location: { $position: -1, description: 'invalid position' } },
    { fly_to_location: { name: 'other' } },
    {
      fly_to_location: {
        parameters: { properties: { arbitrary: { description: 'new field' } } },
      },
    },
    {
      fly_to_location: {
        parameters: { properties: { query: { type: 'number' } } },
      },
    },
    { fly_to_location: { parameters: { required: { 0: 'another' } } } },
    { fly_to_location: { description: { nested: 'invalid' } } },
  ])
    assert.throws(() => createActionTools(descriptions), TypeError);
});

test('all legacy action arguments are byte-identical after removing the deliberate additions', () => {
  const legacy = structuredClone(GEV_ACTION_SCHEMAS).filter(
    (tool) =>
      ![
        'next_satellite_pass',
        'set_cyber_sonar',
        'set_voice_inactivity_timeout',
      ].includes(tool.name),
  );
  // Layer enums are generated from the voice layer manifest and pinned by
  // layerManifest.test.mjs; the two shipped right-rail panels are additive.
  const property = (name) =>
    legacy.find((tool) => tool.name === name).parameters.properties;
  delete property('control_cockpit').voicePanel;
  delete property('set_layer_visibility').layerId.enum;
  delete property('show_data_layers_menu').layerId.enum;
  delete property('get_entity_context').layerId.enum;
  delete property('analyst_query').layers.items.enum;
  // Earth-centered rotation is additive; local camera yaw keeps its contract.
  const motion = property('move_camera').motion;
  assert.deepEqual(motion.enum, [
    'orbit',
    'pan',
    'tilt',
    'rotate',
    'rotate_globe',
    'stop',
  ]);
  motion.enum = motion.enum.filter((value) => value !== 'rotate_globe');
  const panels = property('set_panel_open').panelId;
  panels.enum = panels.enum.filter(
    (id) =>
      ![
        'weather-panel',
        'recent-imagery-panel',
        'voice-settings',
        'voice-preview',
        'provider-settings',
        'utilities-panel',
      ].includes(id),
  );
  for (const tool of legacy) {
    // Point-and-ask adds `referent` arguments and 'pointer' enum values.
    delete tool.parameters.properties.referent;
    for (const value of Object.values(tool.parameters.properties)) {
      if (value.enum)
        value.enum = value.enum.filter((key) => key !== 'pointer');
    }
  }
  const track = legacy.find((tool) => tool.name === 'track_entity').parameters;
  delete track.anyOf;
  delete track.properties.query.minLength;
  delete track.properties.query.pattern;
  track.required = ['query'];
  const analystScopeKind = legacy.find((tool) => tool.name === 'analyst_query')
    .parameters.properties.scope.properties.kind;
  analystScopeKind.enum = analystScopeKind.enum.filter(
    (key) => key !== 'pointer',
  );
  // The analyst centre now requires a real coordinate.
  const center = property('analyst_query').scope.properties.center;
  delete center.required;
  for (const axis of ['lat', 'lon']) {
    delete center.properties[axis].minimum;
    delete center.properties[axis].maximum;
  }
  // Cyber adds one HUD layout and Operator was retired.
  const hud = property('set_hud').layout;
  assert.deepEqual(hud.enum, ['tactical', 'minimal', 'cyber']);
  hud.enum = ['tactical', 'operator', 'minimal'];
  // Snow is retired from set_visual_style; restore it to keep the legacy pin.
  const visualStyle = legacy.find((tool) => tool.name === 'set_visual_style')
    .parameters.properties.style;
  assert.deepEqual(visualStyle.enum, [
    'normal',
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
  ]);
  visualStyle.enum = [...visualStyle.enum, 'snow'];
  // fly_to_location gains the direction the camera faces on arrival.
  delete property('fly_to_location').headingDeg;
  // Derived by applying the same removals to the 4b56d0e9 actionSchemas.
  assert.equal(
    createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    'c9dbb213af29124a926ba9813098598a216e11bfe3635b157ef1edf88a9ffd04',
  );
});

test('globe rotation is an additive camera motion with the existing control arguments', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'move_camera',
  ).parameters;
  for (const motion of ['rotate_globe', 'rotate', 'orbit', 'pan', 'tilt']) {
    assert.deepEqual(
      validateArgs(schema, {
        motion,
        direction: 'right',
        speed: 'slow',
        mode: 'continuous',
      }),
      [],
    );
  }
  assert.ok(validateArgs(schema, { motion: 'spin_camera' }).length > 0);
});

test('track_entity accepts a referent alone but rejects an empty target', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'track_entity',
  ).parameters;
  assert.deepEqual(validateArgs(schema, { referent: 2 }), []);
  assert.deepEqual(validateArgs(schema, { referent: -1 }), []);
  assert.deepEqual(validateArgs(schema, { query: 'UPS793' }), []);
  assert.ok(validateArgs(schema, {}).length > 0);
  assert.ok(validateArgs(schema, { query: '' }).length > 0);
  assert.ok(validateArgs(schema, { query: '   ' }).length > 0);
  assert.ok(validateArgs(schema, { referent: 0 }).length > 0);
  assert.ok(validateArgs(schema, { referent: 6 }).length > 0);
});

test('tools sent to the model never carry a top-level schema combinator', () => {
  for (const tool of createActionTools()) {
    assert.equal(tool.parameters.type, 'object', tool.name);
    for (const key of ['anyOf', 'oneOf', 'allOf', 'enum', 'not'])
      assert.equal(tool.parameters[key], undefined, `${tool.name}.${key}`);
  }
  // The runner still knows track_entity needs a query or a referent.
  const track = GEV_ACTION_SCHEMAS.find((s) => s.name === 'track_entity');
  assert.ok(track.parameters.anyOf);
});

test('the benchmark still rejects an empty track_entity although the model-facing tool omits anyOf', () => {
  assert.ok(
    validateCall(GEV_REALTIME_TOOLS, { name: 'track_entity', args: {} })
      .length > 0,
  );
  assert.deepEqual(
    validateCall(GEV_REALTIME_TOOLS, {
      name: 'track_entity',
      args: { referent: 2 },
    }),
    [],
  );
});

test('globe reset guidance requires a separate explicit command after refusal', () => {
  const paragraph = realtimeInstructions()
    .split('\n')
    .find((line) => line.includes('globe-view-required'));
  assert.ok(paragraph);
  assert.match(paragraph, /calls only move_camera motion rotate_globe/);
  assert.match(paragraph, /explicit user Reset\/Show Globe View/);
  assert.match(paragraph, /never from your own plan/);
  assert.match(paragraph, /bare yes\/ok/);
  assert.match(paragraph, /Do not ask a question/);
});

test('direct voice timeout schema accepts None and exact integers, rejects malformed duration', () => {
  const tool = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'set_voice_inactivity_timeout',
  );
  for (const minutes of [0, 1, 5, 60])
    assert.equal(validateArgs(tool.parameters, { minutes }).length, 0);
  for (const minutes of [-1, 61, 1.5, '5'])
    assert.ok(validateArgs(tool.parameters, { minutes }).length > 0);
});
