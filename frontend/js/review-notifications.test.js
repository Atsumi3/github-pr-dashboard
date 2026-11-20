import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBrowserNotification,
  requestBrowserNotificationPermission,
} from './review-notifications.js';

test('unsupported and denied browsers do not request permission', async () => {
  assert.equal(await requestBrowserNotificationPermission(undefined), 'unsupported');
  let requests = 0;
  class DeniedNotification {}
  DeniedNotification.permission = 'denied';
  DeniedNotification.requestPermission = () => {
    requests += 1;
  };
  assert.equal(await requestBrowserNotificationPermission(DeniedNotification), 'denied');
  assert.equal(requests, 0);
});

test('permission request failures are returned without throwing', async () => {
  class BrokenNotification {}
  BrokenNotification.permission = 'default';
  BrokenNotification.requestPermission = async () => {
    throw new Error('permission unavailable');
  };
  assert.equal(await requestBrowserNotificationPermission(BrokenNotification), 'error');
  assert.equal(
    await requestBrowserNotificationPermission({
      get permission() {
        throw new Error('permission unavailable');
      },
    }),
    'error',
  );
});

test('notification constructor and click-handler failures never escape', () => {
  const brokenPermission = {
    get permission() {
      throw new Error('permission unavailable');
    },
  };
  assert.doesNotThrow(() =>
    assert.equal(createBrowserNotification(brokenPermission, { title: 'review' }), null),
  );

  class BrokenNotification {
    constructor() {
      throw new Error('constructor failed');
    }
  }
  BrokenNotification.permission = 'granted';
  assert.equal(createBrowserNotification(BrokenNotification, { title: 'review' }), null);

  let click;
  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options;
      click = this;
    }
    close() {
      throw new Error('close failed');
    }
  }
  FakeNotification.permission = 'granted';
  const notification = createBrowserNotification(FakeNotification, {
    title: 'New review',
    body: 'example/project #7',
    tag: 'review-example-project-7',
    onClick: () => {
      throw new Error('window open failed');
    },
  });
  assert.equal(notification.title, 'New review');
  assert.equal(notification.options.tag, 'review-example-project-7');
  assert.doesNotThrow(() => click.onclick());

  class BrokenClickAssignment {
    constructor() {
      Object.defineProperty(this, 'onclick', {
        set() {
          throw new Error('handler assignment failed');
        },
      });
    }
  }
  BrokenClickAssignment.permission = 'granted';
  assert.doesNotThrow(() =>
    assert.equal(createBrowserNotification(BrokenClickAssignment, { title: 'review' }), null),
  );
});
