export type IdFactory = () => string;

export function createIdFactory(prefix = "id"): IdFactory {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

export type Clock = () => number;

export function createClock(start = 0): Clock {
  let t = start;
  return () => ++t;
}
