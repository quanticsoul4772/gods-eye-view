#!/usr/bin/env node
/**
 * Browser proof for Ask Claude's page wiring: the dock button and composer,
 * the voice card it writes to, cancel, errors, new chat, the tray rules, the
 * voice gate and the cockpit field. /api/claude/ask is answered with scripted
 * replies, so the gate is deterministic and spends no API credit; the app
 * actions in those replies run for real through the voice runner.
 */
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const headful = process.argv.includes('--headful');

const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  executablePath: chromeExecutablePath(),
  args: [
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const failures = [];
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const check = (name, passed, detail = '') => {
  console.log(
    `  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures.push(name);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Scripted Claude ─────────────────────────────────────────────────────────
// Each request takes the next reply. A reply is a function of the request's
// messages returning { status, body }, or 'hold' to leave the request open.
const replies = [];
const requests = [];
let held = null; // the last request left open, to answer later by hand
const answer = (text) => (messages) => ({
  status: 200,
  body: {
    messages: [
      ...messages,
      { role: 'assistant', content: [{ type: 'text', text }] },
    ],
    answer: text,
  },
});
const action = (id, name, input) => (messages) => ({
  status: 200,
  body: {
    messages: [
      ...messages,
      { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    ],
    pending: [{ id, name, input }],
    results: [],
  },
});
const failure = (status, error) => () => ({
  status,
  body: { answer: null, error },
});

await page.setRequestInterception(true);
page.on('request', (request) => {
  if (!request.url().endsWith('/api/claude/ask')) {
    request.continue();
    return;
  }
  const { messages } = JSON.parse(request.postData() || '{}');
  requests.push(messages);
  const reply = replies.shift();
  if (reply === 'hold') held = { request, messages };
  if (!reply || reply === 'hold') return;
  const { status, body } = reply(messages);
  request
    .respond({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
    .catch(() => {});
});

const ui = () =>
  page.evaluate(() => {
    const control = document.getElementById('gev-voice-control');
    const composer = document.getElementById('gev-ask-composer');
    const card = document.getElementById('gev-voice-card');
    const cockpit = document.getElementById('gev-ask-cockpit');
    const popup = cockpit?.querySelector('.gev-ask-popup');
    return {
      composerOpen: composer ? !composer.hidden : null,
      buttonExpanded: document
        .getElementById('gev-ask-button')
        ?.getAttribute('aria-expanded'),
      active:
        document.activeElement?.id ||
        document.activeElement?.getAttribute('aria-label') ||
        '',
      typed: control?.hasAttribute('data-typed'),
      cardShown: card ? !card.hidden : null,
      kicker: card?.querySelector('.gev-voice-card-kicker')?.textContent,
      who: document.querySelector(
        '#gev-voice-card-assistant .gev-voice-card-who',
      )?.textContent,
      user: document.getElementById('gev-voice-card-user-text')?.textContent,
      reply: document.getElementById('gev-voice-card-assistant-text')
        ?.textContent,
      steps: [...document.querySelectorAll('#gev-voice-card-plan li')].map(
        (li) => li.textContent.trim(),
      ),
      status: composer?.querySelector('.gev-ask-status span')?.textContent,
      tone: composer?.querySelector('.gev-ask-status')?.dataset.tone ?? '',
      cancelShown: !composer?.querySelector('.gev-ask-cancel')?.hidden,
      sendDisabled: composer?.querySelector('button[type=submit]')?.disabled,
      turns: composer?.querySelector('.gev-ask-new')?.dataset.turns ?? '',
      cockpitOpen: cockpit ? !cockpit.hidden : null,
      popup: popup && !popup.hidden ? popup.textContent : null,
      popupMore: popup?.dataset.more,
    };
  });
const turnDone = () =>
  page.waitForFunction(
    () => document.querySelector('#gev-ask-composer .gev-ask-cancel')?.hidden,
    { timeout: 30000 },
  );
const typeAndSend = async (text) => {
  await page.$eval('#gev-ask-composer input', (input) => {
    input.value = '';
    input.focus();
  });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

// The first-run panel claims Escape while it is on top; other gates dismiss
// it the same way.
await page.evaluateOnNewDocument(() =>
  sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
);

try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      document.getElementById('gev-ask-button') &&
      window.__godsEyeView?.voiceCommands?.runner,
    { timeout: 120000 },
  );
  await pause(2000);

  console.log('Dock');
  let state = await ui();
  check(
    'the type button sits in the voice control, composer closed',
    (await page.$('#gev-voice-control #gev-ask-button')) !== null &&
      state.composerOpen === false,
  );
  // The Location tray's search box: a slash typed there is text.
  await page.click('#location-bar .dock-tray-toggle');
  await page.waitForSelector('#location-search', { visible: true });
  await page.focus('#location-search');
  await page.keyboard.press('/');
  check(
    '/ typed in another field stays in that field',
    (await ui()).composerOpen === false &&
      (await page.$eval('#location-search', (input) => input.value)) === '/',
  );
  await page.$eval('#location-search', (input) => {
    input.value = '';
    input.blur();
  });
  await page.click('#location-bar .dock-tray-toggle');
  await pause(400);
  await page.keyboard.press('/');
  state = await ui();
  check(
    '/ opens the composer and focuses its input',
    state.composerOpen &&
      state.buttonExpanded === 'true' &&
      state.active === 'Message for Claude',
    JSON.stringify({ open: state.composerOpen, active: state.active }),
  );

  console.log('A turn with an action');
  const longAnswer = `Cleared the map.\n${'Every annotation is gone. '.repeat(12)}`;
  replies.push(
    action('a1', 'clear_annotations', {}),
    answer(longAnswer.trim()),
  );
  await typeAndSend('Clear the map');
  await turnDone();
  state = await ui();
  check(
    'the card shows the typed turn as CLAUDE',
    state.cardShown && state.kicker === 'CLAUDE' && state.who === 'CLAUDE',
    `${state.kicker}/${state.who}`,
  );
  check('the message is the YOU line', state.user === 'Clear the map');
  check(
    'the action is a finished plan step',
    state.steps.length === 1 && /Clear marks/.test(state.steps[0]),
    JSON.stringify(state.steps),
  );
  check(
    'the reply is shown whole, line breaks included',
    state.reply === longAnswer.trim(),
    `${state.reply?.length} of ${longAnswer.trim().length} chars`,
  );
  const results = requests[1]?.at(-1)?.content ?? [];
  check(
    "the action's result goes back to Claude",
    requests.length === 2 &&
      results.length === 1 &&
      results[0].tool_use_id === 'a1' &&
      JSON.parse(results[0].content).ok === true,
  );
  check(
    'the composer stays open and focused, with one turn counted',
    state.composerOpen &&
      state.active === 'Message for Claude' &&
      state.turns === '1',
    JSON.stringify({ active: state.active, turns: state.turns }),
  );

  console.log('Follow-up and new chat');
  replies.push(answer('Still clear.'));
  await typeAndSend('Anything left?');
  await turnDone();
  check(
    'a follow-up sends the earlier exchange',
    requests.at(-1).length === 5 &&
      requests.at(-1)[0].content.startsWith('Clear the map'),
    `${requests.at(-1).length} messages`,
  );
  await page.click('#gev-ask-composer .gev-ask-new');
  check('new chat clears the turn count', (await ui()).turns === '');
  replies.push(answer('Hello.'));
  await typeAndSend('Hi');
  await turnDone();
  check(
    'after a new chat only the new message is sent',
    requests.at(-1).length === 1,
    `${requests.at(-1).length} messages`,
  );

  console.log('Cancel');
  replies.push('hold');
  await typeAndSend('Take your time');
  await page.waitForFunction(
    () => !document.querySelector('#gev-ask-composer .gev-ask-cancel').hidden,
    { timeout: 5000 },
  );
  state = await ui();
  check(
    'a running turn shows Thinking and Cancel, Send disabled',
    /Thinking/.test(state.status) && state.cancelShown && state.sendDisabled,
    state.status,
  );
  await page.click('#gev-ask-composer .gev-ask-cancel');
  await turnDone();
  state = await ui();
  check('Cancel ends the turn with Cancelled.', state.reply === 'Cancelled.');
  replies.push(answer('Hello again.'));
  await typeAndSend('Still there?');
  await turnDone();
  check(
    'the cancelled message is not sent again',
    requests.at(-1).length === 3 &&
      !JSON.stringify(requests.at(-1)).includes('Take your time'),
    `${requests.at(-1).length} messages`,
  );

  console.log('Errors');
  const replyBefore = (await ui()).reply;
  replies.push(failure(503, 'ANTHROPIC_API_KEY is not set'));
  await typeAndSend('Hello');
  await turnDone();
  state = await ui();
  check(
    'a setup error shows in the composer, not the card',
    state.status === 'ANTHROPIC_API_KEY is not set' &&
      state.tone === 'warn' &&
      state.reply !== 'ANTHROPIC_API_KEY is not set',
    `${state.status} / ${state.reply === replyBefore ? 'card unchanged' : state.reply}`,
  );
  replies.push(failure(502, 'Claude declined this request'));
  await typeAndSend('Hello');
  await turnDone();
  state = await ui();
  check(
    'a turn error becomes the reply line',
    state.reply === 'Claude declined this request' && state.status === '',
  );

  console.log('Closing and trays');
  await page.focus('#gev-ask-composer input');
  await page.keyboard.press('Escape');
  state = await ui();
  check(
    'Escape closes the composer and returns focus to the button',
    !state.composerOpen && state.active === 'gev-ask-button',
    JSON.stringify({ open: state.composerOpen, active: state.active }),
  );
  await page.evaluate(() =>
    document
      .querySelector('.dock-pin-btn[data-pin-target="control-panel"]')
      .click(),
  );
  await pause(400);
  await page.click('#gev-ask-button');
  await pause(400);
  const pinned = await page.evaluate(() => {
    const panel = document.getElementById('control-panel');
    return (
      panel.classList.contains('dock-pinned') &&
      !panel.classList.contains('collapsed')
    );
  });
  check(
    'a pinned tray stays open beside the composer',
    pinned && (await ui()).composerOpen,
  );
  await page.evaluate(() =>
    document
      .querySelector('.dock-pin-btn[data-pin-target="control-panel"]')
      .click(),
  );
  await pause(400);
  if (!(await ui()).composerOpen) await page.click('#gev-ask-button');
  await page.click('#location-bar .dock-tray-toggle');
  await pause(400);
  state = await ui();
  check(
    'opening a tray closes the composer and leaves focus on the tray',
    !state.composerOpen && state.active === 'location-bar-toggle',
    state.active,
  );
  await page.click('#location-bar .dock-tray-toggle');
  await pause(400);

  console.log('Voice gate');
  await page.evaluate(() => {
    const { session } = window.__godsEyeView.voiceCommands;
    session.__qaIsActive = session.isActive;
    session.isActive = () => true;
  });
  await page.click('#gev-ask-button');
  state = await ui();
  check(
    'with voice live, Send is disabled and the composer says why',
    state.sendDisabled && /Voice is on/.test(state.status),
    state.status,
  );
  const sentBefore = requests.length;
  await page.keyboard.type('Hello');
  await page.keyboard.press('Enter');
  await pause(500);
  check('nothing is sent while voice is live', requests.length === sentBefore);
  await page.evaluate(() => {
    const { session } = window.__godsEyeView.voiceCommands;
    session.isActive = session.__qaIsActive;
    delete session.__qaIsActive;
  });
  await page.focus('#gev-ask-composer input');
  await page.keyboard.press('Escape');

  console.log('Cockpit field');
  // The field keys off the cockpit body class and the mode-change event; the
  // live cockpit itself is exercised against real Claude, not here.
  await page.evaluate(() => document.body.classList.add('cockpit-mode'));
  await page.keyboard.press('/');
  state = await ui();
  check(
    'in cockpit, / opens the cockpit field instead of the composer',
    state.cockpitOpen && !state.composerOpen,
  );
  replies.push('hold');
  await page.keyboard.type('next aircraft');
  await page.keyboard.press('Enter');
  await pause(300);
  check(
    'a running cockpit turn says Esc cancels',
    (await ui()).popup === 'Thinking… Esc cancels.',
  );
  await page.keyboard.press('Escape');
  await turnDone();
  await pause(200);
  state = await ui();
  check(
    'the first Escape cancels and keeps the field',
    state.cockpitOpen && state.popup === 'Cancelled.',
    state.popup,
  );
  await page.keyboard.press('Escape');
  check('the second Escape closes the field', !(await ui()).cockpitOpen);
  const longCockpit =
    `Tracking DAL946 ${'heading north over the plains, '.repeat(8)}`.trim();
  replies.push(answer(longCockpit));
  await page.keyboard.press('/');
  await page.keyboard.type('where is it going');
  await page.keyboard.press('Enter');
  await turnDone();
  await pause(200);
  state = await ui();
  check(
    'a long cockpit reply is previewed with more to show',
    state.popupMore === 'true' &&
      state.popup.endsWith('…') &&
      state.popup.length < longCockpit.length,
    `${state.popup?.length} chars`,
  );
  await page.click('#gev-ask-cockpit .gev-ask-popup');
  check(
    'clicking the preview shows the whole reply',
    (await ui()).popup === longCockpit,
  );
  replies.push('hold');
  await page.focus('#gev-ask-cockpit input');
  await page.keyboard.type('and then?');
  await page.keyboard.press('Enter');
  await pause(300);
  await page.evaluate(() => {
    document.body.classList.remove('cockpit-mode');
    dispatchEvent(
      new CustomEvent('gev:cockpit-mode-changed', {
        detail: { active: false },
      }),
    );
  });
  await pause(300);
  check(
    'leaving cockpit closes the field but the turn carries on',
    !(await ui()).cockpitOpen && (await ui()).cancelShown,
  );
  // "exit cockpit" ends the cockpit itself; its reply must still arrive.
  const { body } = answer('Left the cockpit.')(held.messages);
  await held.request.respond({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await turnDone();
  state = await ui();
  check(
    'the rest of the turn shows in the card',
    state.cardShown &&
      state.user === 'and then?' &&
      state.reply === 'Left the cockpit.' &&
      state.kicker === 'CLAUDE',
    JSON.stringify({ user: state.user, reply: state.reply }),
  );

  // An action that ends Cockpit, as "exit cockpit" does: the card picks up
  // the turn with its running step, not just the reply.
  await page.evaluate(() => {
    const commands = window.__godsEyeView.voiceCommands;
    const runner = commands.runner;
    commands.__qaRunner = runner;
    commands.runner = async (name, args, options) => {
      if (name === 'clear_annotations') {
        document.body.classList.remove('cockpit-mode');
        dispatchEvent(
          new CustomEvent('gev:cockpit-mode-changed', {
            detail: { active: false },
          }),
        );
      }
      return runner(name, args, options);
    };
    document.body.classList.add('cockpit-mode');
  });
  replies.push(
    action('x1', 'clear_annotations', {}),
    answer('Cockpit is off.'),
  );
  await page.keyboard.press('/');
  await page.keyboard.type('leave and clear');
  await page.keyboard.press('Enter');
  await turnDone();
  state = await ui();
  check(
    'a turn that ends Cockpit keeps its step in the card',
    state.user === 'leave and clear' &&
      state.steps.length === 1 &&
      /Clear marks, done/.test(state.steps[0]) &&
      state.reply === 'Cockpit is off.',
    JSON.stringify({ steps: state.steps, reply: state.reply }),
  );
  await page.evaluate(() => {
    const commands = window.__godsEyeView.voiceCommands;
    commands.runner = commands.__qaRunner;
    delete commands.__qaRunner;
  });

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  failures.push(error.message);
  console.error(error);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nqa-ask-claude: ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log('\nqa-ask-claude: all checks passed');
}
