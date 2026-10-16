import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackPresentations } from './presentation.js';

test('abort releases an in-flight image URL before the decoder settles or the viewer is destroyed', async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const priorImage = globalThis.Image;
  const priorRevoke = URL.revokeObjectURL;
  const revoked = [];
  globalThis.Image = class {
    decode() {
      return pending;
    }
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    priorRevoke(url);
  };
  const viewer = {
    scene: { requestRender() {} },
    entities: {
      remove() {
        assert.fail('No entity should be acquired');
      },
    },
  };
  const signalOwner = new AbortController();
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, 8);
  header.setUint32(20, 8);
  try {
    const rendering = createPackPresentations(viewer).image({
      pack: {},
      asset: { bytes, mimeType: 'image/png' },
      signal: signalOwner.signal,
    });
    const rejected = assert.rejects(rendering, /abort/i);
    signalOwner.abort();
    assert.equal(
      revoked.length,
      1,
      'object URL must be released synchronously with cancellation',
    );
    settle();
    await rejected;
    assert.equal(revoked.length, 1, 'late decode cannot dispose twice');
  } finally {
    settle();
    globalThis.Image = priorImage;
    URL.revokeObjectURL = priorRevoke;
  }
});

/** A minimal JPEG: SOI, an APP0 segment, then a baseline SOF0 frame header. */
function jpeg(width, height, sof = 0xc0) {
  const bytes = new Uint8Array(2 + 18 + 19);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8]);
  bytes.set([0xff, 0xe0], 2);
  view.setUint16(4, 16); // APP0 length, skipped by the walk
  bytes.set([0xff, sof], 20);
  view.setUint16(22, 17);
  bytes[24] = 8;
  view.setUint16(25, height);
  view.setUint16(27, width);
  return bytes;
}

test('photo size is read from the header before anything decodes it', async () => {
  const { photoDimensions } = await import('./presentation.js');
  assert.deepEqual(photoDimensions('image/jpeg', jpeg(1600, 1067)), {
    width: 1600,
    height: 1067,
  });
  // Progressive JPEGs carry their size in SOF2.
  assert.deepEqual(photoDimensions('image/jpeg', jpeg(800, 600, 0xc2)), {
    width: 800,
    height: 600,
  });
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(png.buffer).setUint32(16, 640);
  new DataView(png.buffer).setUint32(20, 480);
  assert.deepEqual(photoDimensions('image/png', png), {
    width: 640,
    height: 480,
  });
  // A small file that declares a huge picture never reaches the decoder.
  assert.throws(() => photoDimensions('image/jpeg', jpeg(5000, 100)), /limit/);
  assert.doesNotThrow(() => photoDimensions('image/jpeg', jpeg(4096, 4096)));
  assert.throws(() => photoDimensions('image/jpeg', png), /JPEG header/);
  assert.throws(() => photoDimensions('image/png', jpeg(10, 10)), /PNG header/);
  assert.throws(() => photoDimensions('image/webp', png), /JPEG or PNG/);
  // No frame header at all (scan starts first).
  const noFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]);
  assert.throws(() => photoDimensions('image/jpeg', noFrame), /JPEG header/);
});

test('a photo card releases its URL when cancelled mid-decode', async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const priorImage = globalThis.Image;
  const priorRevoke = URL.revokeObjectURL;
  const revoked = [];
  globalThis.Image = class {
    decode() {
      return pending;
    }
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    priorRevoke(url);
  };
  const viewer = {
    scene: { requestRender() {} },
    entities: {
      remove() {
        assert.fail('No marker before the photo decodes');
      },
    },
  };
  const owner = new AbortController();
  try {
    const rendering = createPackPresentations(viewer).photo({
      pack: { id: 'aerial', placement: { anchorId: 'a' } },
      anchors: [
        { id: 'a', title: 'Black River', lat: 18, lon: -77.8, alt: 40 },
      ],
      asset: { bytes: jpeg(1600, 1067), mimeType: 'image/jpeg' },
      signal: owner.signal,
    });
    const rejected = assert.rejects(rendering, /abort/i);
    owner.abort();
    assert.equal(revoked.length, 1);
    settle();
    await rejected;
    assert.equal(revoked.length, 1);
  } finally {
    settle();
    globalThis.Image = priorImage;
    URL.revokeObjectURL = priorRevoke;
  }
});
