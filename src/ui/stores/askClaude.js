import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * @typedef {object} AskClaudeView
 * @property {boolean} open The composer is shown above the dock.
 * @property {boolean} typed The voice card shows a typed turn (CLAUDE labels).
 * @property {{text: string, tone: string}} status The composer's status line.
 * @property {boolean} busy A typed turn is running.
 * @property {boolean} voiceOn A voice session is live, so typing is blocked.
 * @property {number} turns Questions asked in this conversation.
 * @property {number} clear Bumped when the composer's text should be cleared.
 */

/**
 * Typing to Claude from the command dock. installAskClaude (src/ui/askClaude.js)
 * runs the turns and publishes the composer here; the voice control view
 * renders the type button and composer and sends what the person does back to
 * the connected handlers.
 */
export const useAskClaudeStore = defineStore('gev-ask-claude', () => {
  /** @type {import('vue').ShallowRef<?AskClaudeView>} Null while not installed. */
  const view = shallowRef(null);

  /** @param {?AskClaudeView} next A fresh presentation. */
  function publish(next) {
    view.value = next;
  }

  /** The handlers the view calls, or null while none is wired. */
  const controls = shallowRef(null);

  /** @param {?object} next The handlers, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  /**
   * Forward one of the person's actions to the handlers, if any.
   * @param {string} name
   * @param {...unknown} args
   */
  function act(name, ...args) {
    return controls.value?.[name]?.(...args);
  }

  return { view, publish, controls, connect, act };
});
