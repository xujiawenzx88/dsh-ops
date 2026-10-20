/** The real host bridge keeps a one-shot worker primed across calls. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { NativeFileTools } from '../lib/file/runtime.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

requireWorker('native-prewarm')

async function mount(ctx, root, prewarmWorker, mode = 'danger-full-access') {
  await ctx.plugin(Subprocess)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode ?? mode, workspaceRoot: root }),
  }))
  const native = new NativeFileTools({ ctx, config: { workerPath: WORKER, required: true, prewarmWorker } })
  await native.start(['stat'])
  return native
}

const execution = (root, id = 'prewarm-session') => ({ agent: { session: { id, header: { cwd: root } } } })

await test('a completed call primes one worker and the next call consumes it', async () => {
  await withTempDir('native-prewarm', async root => {
    const file = path.join(root, 'notes.txt')
    fs.writeFileSync(file, 'one\ntwo\n')
    const { ctx } = await bootHost()
    const exec = execution(root)
    let native
    try {
      native = await mount(ctx, root, true)
      const first = await native.call('stat', { path: file }, exec)
      assert.equal(first.status, 'completed', JSON.stringify(first))
      assert.equal(native.warm?.size, 1, 'the cold call leaves exactly one idle worker')
      let claims = 0
      const take = native.warm.take.bind(native.warm)
      native.warm.take = (key, signal) => {
        const handle = take(key, signal)
        if (handle) claims++
        return handle
      }
      const second = await native.call('stat', { path: file }, exec)
      assert.equal(second.status, 'completed', JSON.stringify(second))
      assert.deepEqual(second, first, 'the warm call returns the same result')
      assert.equal(claims, 1, 'the second call actually claimed the idle worker')
      assert.equal(native.warm?.size, 1, 'the warm call primes its replacement')
    } finally {
      await native?.stop()
      await shutdown(ctx)
    }
  })
})

await test('prewarmWorker:false keeps the cold one-shot path and leaves no idle worker', async () => {
  await withTempDir('native-prewarm-off', async root => {
    const file = path.join(root, 'notes.txt')
    fs.writeFileSync(file, 'one\n')
    const { ctx } = await bootHost()
    const exec = execution(root)
    let native
    try {
      native = await mount(ctx, root, false)
      const value = await native.call('stat', { path: file }, exec)
      assert.equal(value.status, 'completed', JSON.stringify(value))
      assert.equal(native.warm?.size, 0)
    } finally {
      await native?.stop()
      await shutdown(ctx)
    }
  })
})

await test('an aborted warm claim does not prime a replacement', async () => {
  await withTempDir('native-prewarm-abort', async root => {
    const file = path.join(root, 'notes.txt')
    fs.writeFileSync(file, 'one\n')
    const { ctx } = await bootHost()
    const controller = new AbortController()
    const exec = { ...execution(root), signal: controller.signal }
    let native
    try {
      native = await mount(ctx, root, true)
      assert.equal((await native.call('stat', { path: file }, exec)).status, 'completed')
      assert.equal(native.warm?.size, 1)
      const take = native.warm.take.bind(native.warm)
      native.warm.take = (key, signal) => {
        const handle = take(key, signal)
        if (handle) controller.abort(new Error('test cancellation'))
        return handle
      }
      const value = await native.call('stat', { path: file }, exec)
      assert.equal(value.status, 'error')
      assert.equal(native.warm?.size, 0, 'the aborted claim must not leave an idle replacement')
    } finally {
      await native?.stop()
      await shutdown(ctx)
    }
  })
})

await test('an invalid call never spawns or primes a worker', async () => {
  await withTempDir('native-prewarm-invalid', async root => {
    const { ctx } = await bootHost()
    let native
    try {
      native = await mount(ctx, root, true)
      const value = await native.call('read', { path: '' }, execution(root))
      assert.equal(value.status, 'error')
      assert.equal(native.warm?.size, 0)
    } finally {
      await native?.stop()
      await shutdown(ctx)
    }
  })
})

await test('session disposal and sandbox-mode changes clear idle workers', async () => {
  await withTempDir('native-prewarm-lifecycle', async root => {
    const file = path.join(root, 'notes.txt')
    fs.writeFileSync(file, 'one\n')
    const { ctx } = await bootHost()
    const exec = execution(root)
    let native
    try {
      native = await mount(ctx, root, true)
      assert.equal((await native.call('stat', { path: file }, exec)).status, 'completed')
      assert.equal(native.warm?.size, 1)
      ctx.emit('session/event', exec.agent.session, { type: 'sandbox/mode' })
      assert.equal(native.warm?.size, 0, 'a mode change discards idle workers')
      assert.equal((await native.call('stat', { path: file }, exec)).status, 'completed')
      assert.equal(native.warm?.size, 1)
      ctx.emit('session/disposed', exec.agent.session)
      assert.equal(native.warm?.size, 0, 'session disposal discards idle workers')
    } finally {
      await native?.stop()
      await shutdown(ctx)
    }
  })
})

await test('warm entries are scoped by session identity and policy snapshot', async () => {
  await withTempDir('native-prewarm-scope', async root => {
    const file = path.join(root, 'notes.txt')
    fs.writeFileSync(file, 'one\n')
    const { ctx } = await bootHost()
    const first = execution(root, 'prewarm-a')
    const second = execution(root, 'prewarm-b')
    let native
    try {
      native = await mount(ctx, root, true)
      assert.equal((await native.call('stat', { path: file }, first)).status, 'completed')
      assert.equal(native.warm?.size, 1)
      assert.equal((await native.call('stat', { path: file }, second)).status, 'completed')
      assert.equal(native.warm?.size, 2, 'a different session must not claim the first session entry')
      first.agent.session.mode = 'workspace-write'
      assert.equal((await native.call('stat', { path: file }, first)).status, 'completed')
      assert.equal(native.warm?.size, 3, 'a different policy snapshot must not claim an older entry')
    } finally {
      await native?.stop()
      await shutdown(ctx)
    }
  })
})

report('native-prewarm')
