import PanelRailView from './PanelRailView.vue';
import { PANEL_RAIL_HOST_CLASS, PANEL_RAIL_ITEMS } from './panelRailCatalog.js';
import { usePanelStore } from './stores/panels.js';

/** How long the pointer rests on a rail item before its panel peeks open. */
export const RAIL_PEEK_OPEN_DELAY_MS = 200;
/** How long a peeked panel stays open after the pointer leaves it. */
export const RAIL_PEEK_CLOSE_DELAY_MS = 600;

/**
 * Own the desktop panel rails: publish each side's panels to the panel store
 * and open or close a panel when its rail item is selected. Disclosure itself
 * stays with PanelChrome, which enforces one open panel per side.
 */
export class PanelNavigation {
  /**
   * @param {object} options
   * @param {{pinia: object, mount: Function}} options.ui Shell Vue runtime.
   * @param {{left: HTMLElement|null, right: HTMLElement|null}} options.stacks Side panel stacks.
   * @param {Function} options.setPanelCollapsed PanelChrome's disclosure operation.
   * @param {() => boolean} [options.peekOnHover] Whether resting on a rail
   *   item opens its panel (the Professional layout).
   */
  constructor({ ui, stacks, setPanelCollapsed, peekOnHover = () => false }) {
    this._ui = ui;
    this._stacks = stacks;
    this._setPanelCollapsed = setPanelCollapsed;
    this._peekOnHover = peekOnHover;
    /** The panel each side holds open only while the pointer is on it. */
    this._peeks = { left: null, right: null };
    this._peekTimers = { left: null, right: null };
    this._peekListeners = [];
    this._store = usePanelStore(ui.pinia);
    this._unmounts = [];
    this._hosts = [];
    this._observer = null;
    this._destroyed = false;
  }

  init() {
    if (this._destroyed) return;
    for (const side of ['left', 'right']) {
      const stack = this._stacks[side];
      if (!stack) continue;
      // Inside the stack, the rail shows and hides with its panels in every
      // presentation mode (Cockpit, clean view, recording, phone sheets).
      const host = stack.ownerDocument.createElement('div');
      host.className = `${PANEL_RAIL_HOST_CLASS} ${PANEL_RAIL_HOST_CLASS}--${side}`;
      stack.prepend(host);
      this._hosts.push(host);
      this._unmounts.push(
        this._ui.mount(PanelRailView, host, {
          side,
          onSelect: (panelId) => this.select(panelId),
        }),
      );
      this._listenForPeeks(side, stack, host);
    }
    if (typeof MutationObserver !== 'undefined') {
      // Only the panels themselves matter: their order, disclosure and
      // availability, not changes inside them or inside the rails.
      this._observer = new MutationObserver((records) => {
        if (records.some((record) => this._isPanelRecord(record))) this.sync();
      });
      for (const stack of Object.values(this._stacks)) {
        if (!stack) continue;
        this._observer.observe(stack, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'hidden'],
        });
      }
    }
    this.sync();
  }

  /** Publish both sides' panels in display order. */
  sync() {
    if (this._destroyed) return;
    // A peek closed some other way (Escape, its collapse button) is over.
    for (const side of ['left', 'right']) {
      const peeked = this._peeks[side];
      if (
        peeked &&
        document.getElementById(peeked)?.classList.contains('collapsed')
      )
        this._endPeek(side);
    }
    for (const side of ['left', 'right']) {
      const stack = this._stacks[side];
      const panels = stack
        ? [...stack.children]
            .filter((panel) => panel.matches('[data-panel-id]'))
            .map((panel) => {
              const shownBy = PANEL_RAIL_ITEMS[panel.id]?.shownBy;
              return {
                id: panel.id,
                title:
                  panel
                    .querySelector('.panel-title, .pp-header-label')
                    ?.textContent.trim() || panel.id,
                open: !panel.classList.contains('collapsed'),
                available:
                  !panel.hidden &&
                  (!shownBy || panel.classList.contains(shownBy)),
              };
            })
        : [];
      this._store.setSide(side, panels);
    }
  }

  /**
   * Toggle a panel from its rail item.
   * @param {string} panelId Panel element id.
   */
  select(panelId) {
    if (this._destroyed) return;
    // The panel itself, not the store: the store follows its class a
    // microtask later, after a same-task setPanelCollapsed.
    const panel = document.getElementById(panelId);
    if (!panel) return;
    // Selecting a peeked panel's item keeps it open rather than closing it.
    // A pending peek must not reopen a panel this click closes.
    for (const stackSide of ['left', 'right'])
      if (this._stacks[stackSide]?.contains(panel))
        this._clearPeekTimer(stackSide);
    const side = this._peekSide(panelId);
    if (side) {
      this._endPeek(side);
      this._setPanelCollapsed(panelId, false, { explicit: true });
      return;
    }
    this._setPanelCollapsed(panelId, !panel.classList.contains('collapsed'), {
      explicit: true,
    });
  }

  /**
   * Peek on hover: resting on a rail item opens its panel when that side has
   * none open; leaving the item and the panel closes it again. Peeking is
   * not saved or shared. Pressing inside the panel, or selecting its item,
   * keeps it open, and a panel dragged out to float stays put.
   */
  _listenForPeeks(side, stack, host) {
    const itemIn = (target) =>
      host.contains(target) ? target.closest?.('[data-rail-item]') : null;
    const onPeek = (target) => {
      const panelId = this._peeks[side];
      if (!panelId || !target) return false;
      const panel = document.getElementById(panelId);
      return (
        !!panel?.contains(target) ||
        itemIn(target)?.dataset.railItem === panelId
      );
    };
    const over = (event) => {
      if (onPeek(event.target)) {
        this._clearPeekTimer(side);
        return;
      }
      const item = itemIn(event.target);
      if (!item || item.disabled || !this._peekOnHover()) return;
      const panelId = item.dataset.railItem;
      this._clearPeekTimer(side);
      this._peekTimers[side] = setTimeout(() => {
        this._peekTimers[side] = null;
        this._openPeek(side, stack, panelId);
      }, RAIL_PEEK_OPEN_DELAY_MS);
    };
    const out = (event) => {
      if (onPeek(event.relatedTarget)) return;
      if (!onPeek(event.target) && !itemIn(event.target)) return;
      // Leaving an item drops its pending open; leaving the peek, or an item
      // crossed while one is open, starts the peek's close.
      this._clearPeekTimer(side);
      if (!this._peeks[side]) return;
      this._peekTimers[side] = setTimeout(() => {
        this._peekTimers[side] = null;
        this._closePeek(side);
      }, RAIL_PEEK_CLOSE_DELAY_MS);
    };
    const down = (event) => {
      const panelId = this._peeks[side];
      if (panelId && document.getElementById(panelId)?.contains(event.target)) {
        this._endPeek(side);
        this._setPanelCollapsed(panelId, false, { explicit: true });
      }
    };
    stack.addEventListener('pointerover', over);
    stack.addEventListener('pointerout', out);
    stack.addEventListener('pointerdown', down);
    this._peekListeners.push(() => {
      stack.removeEventListener('pointerover', over);
      stack.removeEventListener('pointerout', out);
      stack.removeEventListener('pointerdown', down);
    });
  }

  _openPeek(side, stack, panelId) {
    if (this._destroyed || !this._peekOnHover()) return;
    const panel = document.getElementById(panelId);
    if (!panel || panel.parentElement !== stack) return;
    if (!panel.classList.contains('collapsed')) return;
    // Another panel the person opened on this side stays.
    const open = [...stack.children].some(
      (child) =>
        child !== panel &&
        child.matches('[data-panel-id]') &&
        !child.hidden &&
        !child.classList.contains('collapsed') &&
        child.id !== this._peeks[side],
    );
    if (open) return;
    this._peeks[side] = panelId;
    this._setPanelCollapsed(panelId, false, {
      persist: false,
      syncShare: false,
    });
  }

  _closePeek(side) {
    const panelId = this._peeks[side];
    this._peeks[side] = null;
    const panel = panelId && document.getElementById(panelId);
    if (
      !panel ||
      panel.classList.contains('collapsed') ||
      panel.classList.contains('panel-floating')
    )
      return;
    this._setPanelCollapsed(panelId, true, {
      persist: false,
      syncShare: false,
    });
  }

  /** Keep a peeked panel open as if the person had opened it. */
  _endPeek(side) {
    this._clearPeekTimer(side);
    this._peeks[side] = null;
  }

  _peekSide(panelId) {
    return (
      ['left', 'right'].find((side) => this._peeks[side] === panelId) ?? null
    );
  }

  _clearPeekTimer(side) {
    clearTimeout(this._peekTimers[side]);
    this._peekTimers[side] = null;
  }

  _isPanelRecord(record) {
    const stacks = Object.values(this._stacks);
    return record.type === 'childList'
      ? stacks.includes(record.target) &&
          [...record.addedNodes, ...record.removedNodes].some(
            (node) => !this._hosts.includes(node),
          )
      : stacks.includes(record.target.parentElement);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._observer?.disconnect();
    this._observer = null;
    for (const side of ['left', 'right']) this._endPeek(side);
    for (const remove of this._peekListeners) remove();
    this._peekListeners = [];
    for (const unmount of this._unmounts) unmount();
    this._unmounts = [];
    for (const host of this._hosts) host.remove();
    this._hosts = [];
  }
}
