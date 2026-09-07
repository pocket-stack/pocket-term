/** Cardinal cursor motion with a repeat delay, velocity-sensitive repeat and
 * hysteresis around diagonals. The public right-stick axes use down-positive Y. */
export function createCursorStick() {
  let direction = "", held = 0;
  return {
    step(x: number, y: number): "Up" | "Down" | "Left" | "Right" | undefined {
      const ax = Math.abs(x), ay = Math.abs(y), strength = Math.max(ax, ay);
      if (strength < 0.22) { direction = ""; held = 0; return; }
      let horizontal = ax > ay;
      if (direction === "Left" || direction === "Right") horizontal = ay < ax * 1.3;
      if (direction === "Up" || direction === "Down") horizontal = ax > ay * 1.3;
      const next = horizontal ? x < 0 ? "Left" : "Right" : y < 0 ? "Up" : "Down";
      if (next !== direction) { direction = next; held = 0; }
      held++;
      const repeat = strength > 0.75 ? 3 : strength > 0.45 ? 5 : 8;
      if (held === 1 || held > 16 && (held - 17) % repeat === 0) return next;
    },
    reset() { direction = ""; held = 0; },
  };
}
