import { serialSupported } from '../meshtastic/session.js';
import { describeNode } from '../layers/localMeshtastic/index.js';

const STYLE = `
#meshtastic-card { position: fixed; top: 92px; left: 50%; transform: translateX(-50%); z-index: 40;
  width: min(280px, calc(100vw - 24px)); font: 13px/1.4 system-ui, sans-serif;
  color: #e8eef2; background: rgba(8, 14, 20, 0.88);
  border: 1px solid rgba(94, 242, 160, 0.4); border-radius: 6px; padding: 8px; }
#meshtastic-card[hidden] { display: none; }
#meshtastic-card header { display: flex; justify-content: space-between;
  align-items: center; gap: 8px; }
#meshtastic-card strong { font-weight: 600; letter-spacing: 0.04em; }
#meshtastic-card button { font: inherit; color: inherit; cursor: pointer;
  background: rgba(94, 242, 160, 0.16); border: 1px solid rgba(94, 242, 160, 0.5);
  border-radius: 4px; padding: 4px 10px; }
#meshtastic-card button[disabled] { opacity: 0.5; cursor: wait; }
#meshtastic-card p { margin: 6px 0 0; color: #b8c4cc; }
#meshtastic-card .node { white-space: pre-line; color: #e8eef2;
  border-top: 1px solid rgba(94, 242, 160, 0.25); padding-top: 6px; }
#meshtastic-card .node:empty { display: none; }
body.ui-clean-view #meshtastic-card, body.ui-embed #meshtastic-card,
body:has(#loading-screen:not(.hidden)) #meshtastic-card { display: none; }
`;

const STATE_TEXT = {
  idle: 'Not connected. Plug a Meshtastic radio in over USB and connect.',
  connecting: 'Choose your radio in the browser’s list…',
  syncing: 'Reading the radio’s node list…',
  live: 'Listening.',
  error: 'Radio error.',
};

/**
 * The connect card for the Local Meshtastic layer: shown while the layer is
 * on. Returns a function that removes it.
 */
export function installMeshtasticCard({
  layer,
  dataManager,
  documentRef = globalThis.document,
  navigatorRef = globalThis.navigator,
  pollMs = 1000,
}) {
  const style = documentRef.createElement('style');
  style.textContent = STYLE;
  const root = documentRef.createElement('section');
  root.id = 'meshtastic-card';
  root.hidden = true;
  root.setAttribute('aria-label', 'Local Meshtastic radio');
  const header = documentRef.createElement('header');
  const title = documentRef.createElement('strong');
  title.textContent = 'MESHTASTIC';
  const button = documentRef.createElement('button');
  button.type = 'button';
  header.append(title, button);
  const text = documentRef.createElement('p');
  text.setAttribute('aria-live', 'polite');
  // The clicked node; plain text, since names come from other people's radios.
  const detail = documentRef.createElement('p');
  detail.className = 'node';
  root.append(header, text, detail);
  documentRef.head.append(style);
  documentRef.body.append(root);

  const supported = serialSupported(navigatorRef);
  let current = { state: 'idle', nodes: [], known: 0 };
  const render = () => {
    const connected = ['syncing', 'live'].includes(current.state);
    button.textContent = connected ? 'Disconnect' : 'Connect';
    button.disabled = !supported || current.state === 'connecting';
    if (!supported) {
      text.textContent =
        'This browser cannot open serial devices. Use desktop Chrome or Edge.';
      return;
    }
    let message = STATE_TEXT[current.state] || '';
    if (current.state === 'error' && current.error)
      message = `Radio error: ${current.error}`;
    if (connected)
      message += ` ${current.known} node(s) known, ${current.nodes.length} with a position.`;
    text.textContent = message;
    detail.textContent = current.selected ? describeNode(current.selected) : '';
  };
  const unsubscribe = layer.subscribe((update) => {
    current = update;
    render();
  });
  const onClick = async () => {
    if (['syncing', 'live'].includes(current.state))
      await layer.session.disconnect();
    else await layer.session.connect();
  };
  button.addEventListener('click', onClick);
  // Show the card only while its layer is on.
  const syncVisibility = () => {
    root.hidden = !dataManager.isEnabled(layer.id);
  };
  syncVisibility();
  const timer = setInterval(syncVisibility, pollMs);
  render();

  return () => {
    clearInterval(timer);
    unsubscribe();
    button.removeEventListener('click', onClick);
    root.remove();
    style.remove();
  };
}
