interface Timers {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

function timers(): Timers {
  return ChromeUtils.importESModule(
    "resource://gre/modules/Timer.sys.mjs",
  ) as Timers;
}

export function scheduleUpdateTimeout(
  callback: () => void,
  delay: number,
): number {
  return timers().setTimeout(callback, delay);
}

export function cancelUpdateTimeout(handle: unknown): void {
  timers().clearTimeout(Number(handle));
}
