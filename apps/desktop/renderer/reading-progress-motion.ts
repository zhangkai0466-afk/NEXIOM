export interface ReadingScrollState { position: number; velocity: number }

/** Critically damped following preserves velocity when a new action extends the chain. */
export function advanceReadingScroll(state: ReadingScrollState, target: number, elapsedMs: number): ReadingScrollState {
  const seconds = Math.max(0, Math.min(elapsedMs, 64)) / 1000;
  if (!seconds) return state;
  const frequency = 16;
  const offset = state.position - target;
  const impulse = state.velocity + frequency * offset;
  const decay = Math.exp(-frequency * seconds);
  const position = target + (offset + impulse * seconds) * decay;
  const velocity = (state.velocity - frequency * impulse * seconds) * decay;
  return Math.abs(target - position) < 0.25 && Math.abs(velocity) < 2
    ? { position: target, velocity: 0 }
    : { position, velocity };
}

// Only presentation is staggered; finished actions never pretend to be running.
export function readingArrivalDelay(indexInBatch: number, pendingDelay = 0): number {
  return Math.min(Math.max(indexInBatch, 0) * 55 + Math.max(pendingDelay, 0), 220);
}
