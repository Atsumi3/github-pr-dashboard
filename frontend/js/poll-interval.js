export function pollIntervalMs(settings) {
  const seconds = Number(settings?.pollInterval);
  return Number.isFinite(seconds) && seconds >= 15 && seconds <= 3600 ? seconds * 1000 : 60_000;
}
