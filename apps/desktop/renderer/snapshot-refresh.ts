type Completion = { promise: Promise<void>; resolve(): void };
const completion = (): Completion => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

export type RefreshFailure = { error: unknown; retrying: boolean };
export type SnapshotRefresh<T> = {
  refresh(): Promise<void>;
  changed(): void;
  accept(snapshot: T): void;
  dispose(): void;
};

export function canRetrySnapshot(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/本地核心(?:已退出|不可用|启动失败)/.test(message);
}

/** One read at a time, shared by notifications and explicit refreshes. */
export function createSnapshotRefresh<T>(options: {
  load(): Promise<T>;
  onSnapshot(snapshot: T): void;
  onFailure(failure: RefreshFailure): void;
  onRecovered(): void;
  onSettled(): void;
  canRetry?: (error: unknown) => boolean;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}): SnapshotRefresh<T> {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let disposed = false;
  let epoch = 0;
  let failures = 0;
  let pending = false;
  let nextCompletion: Completion | undefined;
  let flight: { epoch: number; completion: Completion } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const later = (delay: number) => {
    clearTimer();
    timer = schedule(() => {
      timer = undefined;
      if (!disposed) void start();
    }, delay);
  };
  const retryDelay = () => Math.min(1000 * 2 ** Math.min(failures - 1, 4), 10000);
  const settleQueued = () => {
    nextCompletion?.resolve();
    nextCompletion = undefined;
  };

  function start(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (flight) {
      pending = true;
      nextCompletion ??= completion();
      return nextCompletion.promise;
    }
    clearTimer();
    pending = false;
    const current = { epoch: ++epoch, completion: nextCompletion ?? completion() };
    nextCompletion = undefined;
    flight = current;
    void (async () => {
      let failed = false;
      let retry = false;
      try {
        const snapshot = await options.load();
        if (!disposed && current.epoch === epoch) {
          failures = 0;
          options.onSnapshot(snapshot);
          options.onRecovered();
        }
      } catch (error) {
        if (!disposed && current.epoch === epoch) {
          failed = true;
          retry = (options.canRetry ?? canRetrySnapshot)(error);
          failures = retry ? failures + 1 : 0;
          options.onFailure({ error, retrying: retry });
        }
      } finally {
        flight = undefined;
        current.completion.resolve();
        if (disposed) return;
        if (current.epoch === epoch) options.onSettled();
        if (failed) {
          // A notification burst during the failed read must not defeat backoff.
          pending = false;
          if (retry) later(retryDelay());
          else settleQueued();
        } else if (pending) later(32);
        else if (failures) later(retryDelay());
      }
    })();
    return current.completion.promise;
  }

  return {
    refresh: start,
    changed() {
      if (disposed) return;
      pending = true;
      if (!flight && timer === undefined) later(32);
    },
    accept(snapshot) {
      if (disposed) return;
      // A command result supersedes older reads, but does not clear a read error.
      ++epoch;
      options.onSnapshot(snapshot);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++epoch;
      clearTimer();
      flight?.completion.resolve();
      nextCompletion?.resolve();
      nextCompletion = undefined;
      pending = false;
    },
  };
}
