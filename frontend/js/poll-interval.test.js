import assert from 'node:assert/strict';
import test from 'node:test';
import { pollIntervalMs } from './poll-interval.js';

test('poll interval converts valid settings to milliseconds', () => {
  assert.equal(pollIntervalMs({ pollInterval: 60 }), 60_000);
  assert.equal(pollIntervalMs({ pollInterval: 300 }), 300_000);
  assert.equal(pollIntervalMs({ pollInterval: 15 }), 15_000);
  assert.equal(pollIntervalMs({ pollInterval: 3600 }), 3_600_000);
  assert.equal(pollIntervalMs({ pollInterval: 30.5 }), 30_500);
});

test('invalid or missing poll intervals fall back to the documented 60-second default', () => {
  assert.equal(pollIntervalMs(null), 60_000);
  assert.equal(pollIntervalMs({ pollInterval: 14 }), 60_000);
  assert.equal(pollIntervalMs({ pollInterval: 3601 }), 60_000);
  assert.equal(pollIntervalMs({ pollInterval: Number.NaN }), 60_000);
  assert.equal(pollIntervalMs({ pollInterval: Number.POSITIVE_INFINITY }), 60_000);
});
