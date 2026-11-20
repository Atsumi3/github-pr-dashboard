import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api.js';
import { initSettings } from './settings.js';

function installSettingsDom(t, notificationApi, pollPresets = null, browserApis = {}) {
  const handlers = {};
  const windowHandlers = {};
  const documentHandlers = {};
  const button = {
    disabled: false,
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
  };
  const status = { textContent: '' };
  const descriptors = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    Notification: Object.getOwnPropertyDescriptor(globalThis, 'Notification'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      hidden: false,
      getElementById: (id) => {
        if (id === 'poll-presets') return pollPresets;
        if (id === 'btn-enable-notifications') return button;
        if (id === 'notification-status') return status;
        return null;
      },
      ...(browserApis.documentEvents && {
        addEventListener: (name, handler) => {
          documentHandlers[name] = handler;
        },
      }),
    },
  });
  if (notificationApi) {
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: notificationApi,
    });
  } else {
    delete globalThis.Notification;
  }
  if (browserApis.windowEvents) {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (name, handler) => {
          windowHandlers[name] = handler;
        },
      },
    });
  } else {
    delete globalThis.window;
  }
  if (browserApis.permissions) {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { permissions: browserApis.permissions },
    });
  } else {
    delete globalThis.navigator;
  }
  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { button, handlers, status, windowHandlers, documentHandlers };
}

test('permission request is deferred until Enable notifications is clicked', async (t) => {
  let requests = 0;
  class MockNotification {}
  MockNotification.permission = 'default';
  MockNotification.requestPermission = async () => {
    requests += 1;
    return 'granted';
  };
  const { button, handlers, status } = installSettingsDom(t, MockNotification);

  initSettings();
  assert.equal(requests, 0);
  assert.match(status.textContent, /badges and in-app alerts work without it/);

  await handlers.click();
  assert.equal(requests, 1);
  assert.equal(button.disabled, true);
  assert.match(status.textContent, /notifications enabled/);
});

test('denied notification permission gives actionable feedback', (t) => {
  class DeniedNotification {}
  DeniedNotification.permission = 'denied';
  const denied = installSettingsDom(t, DeniedNotification);
  initSettings();
  assert.equal(denied.button.disabled, true);
  assert.match(denied.status.textContent, /Allow notifications in this site’s browser settings/);
});

test('failed permission requests show guidance and leave the control retryable', async (t) => {
  class BrokenNotification {}
  BrokenNotification.permission = 'default';
  BrokenNotification.requestPermission = async () => {
    throw new Error('permission unavailable');
  };
  const broken = installSettingsDom(t, BrokenNotification);
  initSettings();

  await broken.handlers.click();

  assert.equal(broken.button.disabled, false);
  assert.match(broken.status.textContent, /Could not request permission/);
});

test('unsupported browsers are identified without requesting permission', (t) => {
  const unsupported = installSettingsDom(t, undefined);
  initSettings();
  assert.equal(unsupported.button.disabled, true);
  assert.match(unsupported.status.textContent, /Not supported/);
});

test('permission getter failures are reported without breaking initialization', (t) => {
  class BrokenNotification {}
  Object.defineProperty(BrokenNotification, 'permission', {
    get() {
      throw new Error('permission unavailable');
    },
  });
  const broken = installSettingsDom(t, BrokenNotification);

  initSettings();

  assert.equal(broken.button.disabled, false);
  assert.match(broken.status.textContent, /Could not request permission/);
});

test('Permissions API changes refresh permission status without prompting', async (t) => {
  let requests = 0;
  class MockNotification {}
  MockNotification.permission = 'granted';
  MockNotification.requestPermission = async () => {
    requests += 1;
    return 'granted';
  };
  const listeners = {};
  const permissionStatus = {
    addEventListener: (name, handler) => {
      listeners[name] = handler;
    },
  };
  const browserApis = {
    permissions: {
      query: async ({ name }) => {
        assert.equal(name, 'notifications');
        return permissionStatus;
      },
    },
  };
  const { button, status } = installSettingsDom(t, MockNotification, null, browserApis);

  initSettings();
  await Promise.resolve();
  MockNotification.permission = 'denied';
  listeners.change();

  assert.equal(button.disabled, true);
  assert.match(status.textContent, /Allow notifications in this site’s browser settings/);
  assert.equal(requests, 0);
});

test('focus and visible transitions refresh permission when Permissions API rejects', async (t) => {
  let requests = 0;
  class MockNotification {}
  MockNotification.permission = 'granted';
  MockNotification.requestPermission = async () => {
    requests += 1;
    return 'granted';
  };
  const { button, status, windowHandlers, documentHandlers } = installSettingsDom(
    t,
    MockNotification,
    null,
    {
      windowEvents: true,
      documentEvents: true,
      permissions: { query: async () => Promise.reject(new Error('not supported')) },
    },
  );

  initSettings();
  MockNotification.permission = 'default';
  windowHandlers.focus();

  assert.equal(button.disabled, false);
  assert.match(status.textContent, /badges and in-app alerts work without it/);
  assert.equal(requests, 0);

  MockNotification.permission = 'denied';
  document.hidden = true;
  documentHandlers.visibilitychange();
  assert.match(status.textContent, /badges and in-app alerts work without it/);

  document.hidden = false;
  documentHandlers.visibilitychange();
  assert.equal(button.disabled, true);
  assert.match(status.textContent, /Allow notifications in this site’s browser settings/);
  assert.equal(requests, 0);
});

test('permission changes during a pending request do not leave stale granted UI', async (t) => {
  let requests = 0;
  let resolveRequest;
  class MockNotification {}
  MockNotification.permission = 'default';
  MockNotification.requestPermission = () => {
    requests += 1;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  };
  const listeners = {};
  const permissionStatus = {
    addEventListener: (name, handler) => {
      listeners[name] = handler;
    },
  };
  const { button, handlers, status } = installSettingsDom(t, MockNotification, null, {
    permissions: { query: async () => permissionStatus },
  });

  initSettings();
  await Promise.resolve();
  const requestPromise = handlers.click();
  assert.equal(button.disabled, true);
  assert.match(status.textContent, /Requesting permission/);

  MockNotification.permission = 'denied';
  listeners.change();
  assert.match(status.textContent, /Requesting permission/);

  resolveRequest('granted');
  await requestPromise;

  assert.equal(button.disabled, true);
  assert.match(status.textContent, /Allow notifications in this site’s browser settings/);
  assert.equal(requests, 1);
});

test('successful interval changes invoke the polling restart callback with the selected setting', async (t) => {
  const previousSettings = api.settings;
  const previousUpdateSettings = api.updateSettings;
  api.settings = async () => ({ pollInterval: 60 });
  api.updateSettings = async () => ({ pollInterval: 30 });
  t.after(() => {
    api.settings = previousSettings;
    api.updateSettings = previousUpdateSettings;
  });

  const active = new Set();
  const handlers = {};
  const presetButton = {
    dataset: { seconds: '30' },
    textContent: '30s',
    classList: {
      toggle: (name, enabled) => (enabled ? active.add(name) : active.delete(name)),
      contains: (name) => active.has(name),
    },
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
  };
  const presets = { querySelectorAll: () => [presetButton] };
  installSettingsDom(t, undefined, presets);
  const changedIntervals = [];

  initSettings({ onPollIntervalChange: (seconds) => changedIntervals.push(seconds) });
  await handlers.click();

  assert.deepEqual(changedIntervals, [30]);
  assert.equal(active.has('active'), true);
});
