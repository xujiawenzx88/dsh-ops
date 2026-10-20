import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { FileToolName } from '../capabilities/registry.js'
import { WORKER_TIMEOUT_MS } from '../worker-protocol.js'
import { publicToolName } from '../policy.js'
import { definition } from './contract.js'
import { NATIVE_FILE_TOOLS } from '../capabilities/registry.js'
import { resultDefinition, invokeResult } from './result.js'
import { registerNativeProvider } from './result-provider.js'
import { safeDisposeAll } from '../teardown.js'
import { invoke, failure } from './worker.js'
import { WarmWorkerPool } from './warm-worker.js'
import { createNativeReadDedup } from '../modes/native/read-dedup.js'

type Execution = Parameters<ToolDefinition['execute']>[1]
type NativeToolName = FileToolName | 'result'
export interface NativeRuntimeConfig { workerPath?: string; required?: boolean; denyCredentialReads?: boolean; prewarmWorker?: boolean; toolCallTimeoutMs?: number }
type Reporter = (message: string, level?: string) => void
export class NativeFileTools {
  readonly ctx: Context
  readonly config: NativeRuntimeConfig
  readonly report: Reporter
  file: string | undefined
  readonly active: Map<AbortController, Promise<unknown>>
  readonly disposers: (() => void)[]
  readonly warm: WarmWorkerPool | undefined
  private stopped: boolean
  private readonly readDedup: ReturnType<typeof createNativeReadDedup>
  private unregisterProvider: (() => void) | undefined
  constructor({ ctx, config, report }: { ctx: Context; config: NativeRuntimeConfig; report?: Reporter }) {
    this.ctx = ctx
    this.config = config
    this.report = report ?? (() => {})
    this.file = undefined
    this.active = new Map()
    this.disposers = []
    this.stopped = false
    this.readDedup = createNativeReadDedup(ctx)
    let subprocess: SubprocessRuntime | undefined
    try {
      subprocess = typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined
    } catch { subprocess = undefined }
    this.warm = subprocess && typeof subprocess.spawn === 'function' ? new WarmWorkerPool(subprocess) : undefined
    if (this.warm && config.prewarmWorker === true && typeof this.ctx.on === 'function') {
      // An idle worker has no request or authority, but it must not outlive the
      // session lifetime or the policy snapshot that produced its key.
      const onDisposed = this.ctx.on('session/disposed', session => {
        if (typeof session?.id === 'string') this.warm?.clearSession(session.id)
      })
      const onEvent = this.ctx.on('session/event', (session, event) => {
        if (event?.type === 'sandbox/mode' && typeof session?.id === 'string') this.warm?.clearSession(session.id)
      })
      this.disposers.push(() => { onDisposed() }, () => { onEvent() })
    }
  }

  async start(names: readonly NativeToolName[] = NATIVE_FILE_TOOLS as readonly NativeToolName[]): Promise<string[]> {
    this.file = this.config.workerPath
    if (!this.file) {
      if (this.config.required) throw new Error('Native file worker path is unavailable.')
      return []
    }
    const definitions = names.map(rawName => this.definition(rawName))
    this.unregisterProvider = await registerNativeProvider(this.ctx, definitions, tool => this.ctx.tools.register(tool))
    return names.map(publicToolName)
  }

  definition(rawName: NativeToolName): ToolDefinition {
    const execute: ToolDefinition['execute'] = (args, exec) => this.call(rawName, args, exec)
    return this.readDedup.wrap(rawName === 'result' ? resultDefinition(execute) : definition(rawName, execute))
  }

  async call(tool: NativeToolName, args: unknown, exec: Execution): Promise<unknown> {
    if (this.stopped) return failure('POLICY_DENIED', 'Native file component is disposed.')
    if (!this.file) return failure('EXECUTOR_UNAVAILABLE', 'Native file worker path is unavailable.')
    const controller = new AbortController()
    const abort = () => controller.abort(exec?.signal?.reason)
    if (exec?.signal?.aborted) abort()
    else exec?.signal?.addEventListener?.('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('Native file call timed out')), Math.min(this.config.toolCallTimeoutMs ?? WORKER_TIMEOUT_MS, WORKER_TIMEOUT_MS))
    timer.unref?.()
    const work = tool === 'result'
      ? invokeResult(this.ctx, this.file, args, exec, controller.signal, this.config)
      : invoke(this.ctx, this.file, tool, args, exec, controller.signal, this.config, this.warm)
    this.active.set(controller, work)
    try { return await work }
    finally {
      clearTimeout(timer)
      this.active.delete(controller)
      exec?.signal?.removeEventListener?.('abort', abort)
    }
  }

  cancel(reason: string): void {
    this.warm?.clear()
    for (const controller of this.active.keys()) controller.abort(new Error(reason))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.readDedup.dispose()
    // Disable priming before awaiting active calls: their finally blocks must
    // not create a replacement after the component has begun shutting down.
    const warmDisposal = this.warm?.dispose()
    safeDisposeAll([this.unregisterProvider].filter((dispose): dispose is () => void => typeof dispose === 'function'), error => this.report('dsh-ops-zx88: Native pager teardown failed: ' + error, 'warn'), 'result provider')
    for (const controller of this.active.keys()) controller.abort(new Error('Native file component unloaded'))
    await Promise.allSettled(this.active.values())
    await warmDisposal
    // Isolate each teardown: one throwing worker registration must not strand the rest.
    safeDisposeAll(this.disposers.splice(0), (error, where) => {
      this.report(`dsh-ops-zx88: ${where} teardown failed: ${error instanceof Error ? error.message : String(error)}`, 'warn')
    }, 'file runtime stop')
  }
}
