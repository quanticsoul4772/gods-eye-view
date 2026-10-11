import { GOOGLE_TOKEN_PATH } from '../../src/maps/googleTokens.js';

/**
 * Finish unmatched API requests before Vite's HTML fallback. Install last.
 *
 * The app asks for Google tiles tokens whenever it has no browser key. A
 * provider that offers them is installed earlier and answers first; otherwise
 * this answers 204, which the app reads as "no tokens" without the 404 the
 * browser would log as a console error.
 */
export function apiNotFoundPlugin() {
  const install = (server) => {
    server.middlewares.use(GOOGLE_TOKEN_PATH, (_req, res) => {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    });
    server.middlewares.use('/api', (_req, res) => {
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Unknown API route' }));
    });
  };
  return {
    name: 'api-not-found',
    configureServer: install,
    configurePreviewServer: install,
  };
}
