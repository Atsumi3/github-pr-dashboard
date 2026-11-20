import assert from 'node:assert/strict';
import test from 'node:test';

import { readCache } from './local-cache.js';

test('readCache can propagate storage failures for tracker state reconciliation', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() {
        throw new Error('storage unavailable');
      },
    },
  });

  try {
    assert.throws(
      () => readCache('reviewTracker', Number.POSITIVE_INFINITY, { throwOnError: true }),
      /storage unavailable/,
    );
    assert.equal(readCache('reviewTracker', Number.POSITIVE_INFINITY), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
