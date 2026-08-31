export function isWindowAlive(win?: Window) {
  return Boolean(win && !Components.utils.isDeadWrapper(win) && !win.closed);
}
