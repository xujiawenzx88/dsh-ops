/**
 * Idle one-shot worker pool for the native file bridge.
 *
 * A warm entry is a real worker process spawned ahead of the next call. It has
 * not received a request yet, so it owns no authority and has touched no file:
 * the bridge writes exactly one envelope and closes stdin when it claims the
 * entry, and the worker exits after that one request. This keeps the one-shot
 * process model (and its per-call authority checks) intact while removing the
 * process startup from the measured call.
 *
 * The pool is deliberately small: a session may keep at most one entry, and the
 * map for one file row is capped so a burst of sessions cannot accumulate
 * workers. An idle entry is terminated on the component's stop and after a
 * fixed idle period. A worker that dies while idle is dropped on the next
 * claim, and a claim only happens when the entry still exposes its stdin.
 */
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { WORKER_OUTPUT_BYTES } from '../worker-protocol.js'

/** How long an unused worker may stay alive after the call that primed it. */
const WARM_IDLE_MS = 5 * 60 * 1000
/** Upper bound on idle workers across every session in one plugin row. */
const WARM_MAX_IDLE = 4
/** stderr is diagnostic only; keep the same narrow bound as the cold spawn. */
const WARM_STDERR_BYTES = 16 * 1024

export interface WarmSpawnSpec {
  /** Worker executable plus arguments; identical to the cold spawn argv. */
  argv: readonly string[]
  /** The session cwd the cold spawn would have used. */
  cwd: string
}

export interface WarmWorkerPoolOptions {
  /** Test seam; production uses {@link WARM_IDLE_MS}. */
  idleMs?: number
  /** Test seam; production uses {@link WARM_MAX_IDLE}. */
  maxIdle?: number
}

interface WarmEntry {
  readonly key: string
  readonly sessionId: string
  readonly handle: SubprocessHandle
  alive: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

export class WarmWorkerPool {
  private readonly subprocess: SubprocessRuntime
  private readonly entries = new Map<string, WarmEntry>()
  private readonly lifecycle = new AbortController()
  private readonly idleMs: number
  private readonly maxIdle: number
  private disposed = false

  constructor(subprocess: SubprocessRuntime, options: WarmWorkerPoolOptions = {}) {
    this.subprocess = subprocess
    this.idleMs = options.idleMs ?? WARM_IDLE_MS
    this.maxIdle = options.maxIdle ?? WARM_MAX_IDLE
  }

  /** Number of idle workers; exposed for lifecycle tests and diagnostics. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Claim the idle worker for one call. The entry is removed before the caller
   * writes its envelope, so concurrent calls never share a process.
   * @param key - the session/policy/worker identity that produced the entry.
   * @param signal - the call signal; an already-aborted call never claims one.
   * @returns the live handle, or undefined when the caller must spawn cold.
   */
  take(key: string, signal?: AbortSignal): SubprocessHandle | undefined {
    if (this.disposed || signal?.aborted) return undefined
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (!entry.alive || !entry.handle.stdin) {
      this.discard(entry)
      return undefined
    }
    this.entries.delete(key)
    this.clearTimer(entry)
    entry.alive = false
    return entry.handle
  }

  /**
   * Spawn a replacement after a call consumed or spawned a worker. Failure to
   * prime is never fatal: the next call falls back to the cold path.
   * @param key - the session/policy/worker identity this entry may serve.
   * @param spec - the cold spawn's argv and cwd.
   * @param sessionId - session owner, used to discard entries when it closes.
   */
  prime(key: string, spec: WarmSpawnSpec, sessionId = ''): void {
    if (this.disposed || this.entries.has(key) || this.entries.size >= this.maxIdle) return
    let handle: SubprocessHandle
    try {
      handle = this.subprocess.spawn({
        argv: spec.argv,
        cwd: spec.cwd,
        stdio: { stdin: 'pipe', stdout: { maxBytes: WORKER_OUTPUT_BYTES }, stderr: { maxBytes: WARM_STDERR_BYTES } },
        graceMs: 1000,
        signal: this.lifecycle.signal,
      })
    } catch { return }
    const entry: WarmEntry = { key, sessionId, handle, alive: true, timer: undefined }
    // A process that dies while idle must leave the map promptly; the
    // rejection is handled here as well as by the eventual claim. Attach before
    // validating stdio: a provider that rejected `done` must not be unhandled.
    void handle.done.then(() => this.retire(entry), () => this.retire(entry))
    if (!handle.stdin || !handle.collected.stdout || !handle.collected.stderr) {
      entry.alive = false
      try { handle.terminate() } catch { /* the handle is already unusable */ }
      return
    }
    // The provider installs this only for its data-mode stdin; this pipe is ours.
    handle.stdin.on?.('error', () => {})
    this.entries.set(key, entry)
    entry.timer = setTimeout(() => this.discard(entry), this.idleMs)
    entry.timer.unref?.()
  }

  /** Terminate every idle worker but keep the pool usable for later calls. */
  clear(): void {
    for (const entry of [...this.entries.values()]) this.discard(entry)
  }

  /** Terminate idle workers owned by one session, e.g. when it is disposed. */
  clearSession(sessionId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.sessionId === sessionId) this.discard(entry)
    }
  }

  /** Terminate every idle worker and refuse further priming. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.abort(new Error('dsh-ops warm worker pool disposed'))
    const entries = [...this.entries.values()]
    for (const entry of entries) this.discard(entry)
    await Promise.allSettled(entries.map(entry => entry.handle.done))
  }

  private clearTimer(entry: WarmEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
  }

  /** Remove an idle entry and terminate its process. */
  private discard(entry: WarmEntry): void {
    entry.alive = false
    this.clearTimer(entry)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    try { entry.handle.terminate() } catch { /* best effort */ }
  }

  /** Drop an entry whose process already exited; there is nothing to terminate. */
  private retire(entry: WarmEntry): void {
    entry.alive = false
    this.clearTimer(entry)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
  }
}
