import {
  TRANSIT_ENABLED_FEEDS,
  getRegisteredTransitFeed,
} from '../../data/transitFeeds.js';

/**
 * The feeds this layer can poll: the static registry, plus feeds the server
 * adds from the keyless source directory (served by `/api/transit/feeds`).
 * Static entries keep their registry objects, which carry route-mode
 * functions JSON can't. Until the served catalog loads, the static list stands.
 */
export function createCatalog({ state, source }) {
  state._catalog = new Map(
    TRANSIT_ENABLED_FEEDS.map((feed) => [feed.id, feed]),
  );
  let loading = null;

  return {
    /** Load the served catalog once per enable; resolves true when it changed. */
    load(signal) {
      if (typeof source.getFeeds !== 'function') return Promise.resolve(false);
      loading ??= source
        .getFeeds({ signal })
        .then((rows) => {
          const next = new Map(
            TRANSIT_ENABLED_FEEDS.map((feed) => [feed.id, feed]),
          );
          for (const row of rows)
            if (
              !next.has(row.id) &&
              row.center &&
              Number.isFinite(row.loadRadiusKm)
            )
              next.set(row.id, Object.freeze({ ...row }));
          const changed = next.size !== state._catalog.size;
          state._catalog = next;
          return changed;
        })
        .catch(() => false)
        .finally(() => {
          loading = null;
        });
      return loading;
    },
    feeds() {
      return [...state._catalog.values()];
    },
    /** Any feed by id: catalog first, then the static registry (credits). */
    get(id) {
      return state._catalog.get(id) || getRegisteredTransitFeed(id);
    },
  };
}

/** `south,west,north,east` view bounds → the `bbox` query a national feed needs. */
export function viewBboxParam(bounds) {
  if (!bounds) return null;
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return [bounds.south, bounds.west, bounds.north, bounds.east]
    .map(r)
    .join(',');
}
