export async function requestBrowserNotificationPermission(
  NotificationApi = globalThis.Notification,
) {
  if (!NotificationApi) return 'unsupported';
  try {
    if (NotificationApi.permission !== 'default') return NotificationApi.permission;
    const permission = await NotificationApi.requestPermission();
    return ['granted', 'denied', 'default'].includes(permission) ? permission : 'error';
  } catch {
    return 'error';
  }
}

export function createBrowserNotification(NotificationApi, { title, body, tag, onClick } = {}) {
  if (!NotificationApi) return null;
  try {
    if (NotificationApi.permission !== 'granted') return null;
  } catch {
    return null;
  }
  let notification;
  try {
    notification = new NotificationApi(title, { body, tag });
  } catch {
    return null;
  }

  try {
    notification.onclick = () => {
      try {
        onClick?.();
      } catch {
        // A notification click must not affect dashboard state or polling.
      }
      try {
        notification.close?.();
      } catch {
        // Some browser implementations do not expose a usable close method.
      }
    };
  } catch {
    return null;
  }
  return notification;
}
