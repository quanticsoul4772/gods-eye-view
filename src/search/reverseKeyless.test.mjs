// Keyless reverse geocoding is opt-in per call. Without a Google key, a caller
// that passes { keyless: true } (a user's question, the armed prefetch) gets
// Photon; any other caller (the HUD's automatic summary) gets nothing and sends
// nothing to a third party.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultPlaceSearch } from './defaults.js';

function service() {
  const urls = [];
  const search = createDefaultPlaceSearch({
    resolveApiKey: () => null,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          features: [
            {
              properties: {
                name: 'Covent Garden',
                city: 'London',
                country: 'United Kingdom',
              },
            },
          ],
        }),
      };
    },
  });
  return { search, urls };
}

test('without a key, an automatic reverse lookup sends nothing', async () => {
  const { search, urls } = service();
  assert.equal(await search.reverseGeocode(51.507, -0.128), null);
  assert.deepEqual(urls, []);
});

test('without a key, an opted-in reverse lookup asks Photon', async () => {
  const { search, urls } = service();
  const place = await search.reverseGeocode(51.507, -0.128, { keyless: true });
  assert.equal(place.locality, 'London');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/photon\.komoot\.io\/reverse\?/);
});
