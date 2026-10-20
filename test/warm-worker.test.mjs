/** Idle one-shot worker pool: claim, replacement, fallback and teardown. */
import { WarmWorkerPool } from '../lib/file/warm-worker.js'
import { assert, tick, test, report } from './lib/harness.mjs'

class FakeHandle {
  constructor(spec, state) {
    this.spec = spec
    this.state = state
    this.input = ''
    this.terminated = false
    this.done = new Promise(resolve => { this.resolveDone = resolve })
    this.stdin = {
      end: data => {
        this.input += String(data)
        state.requests.push(this.input)
        this.resolveDone({ exitCode: 0, signal: null })
      },
    }
    this.stdout = { readFrom: () => ({ text: '{"status":"completed"}', lossy: false }) }
    this.stderr = { readFrom: () => ({ text: '', lossy: false }) }
    this.collected = { stdout: this.stdout, stderr: this.stderr }
  }
  terminate() {
    if (this.terminated) return
    this.terminated = true
    this.resolveDone({ exitCode: null, signal: 'SIGTERM' })
  }
}

function fixture(options) {
  const state = { handles: [], requests: [] }
  const subprocess = { spawn(spec) { const handle = new FakeHandle(spec, state); state.handles.push(handle); return handle } }
  return { pool: new WarmWorkerPool(subprocess, options), state }
}

const spec = { argv: ['worker'], cwd: '.' }

await test('a primed worker is claimed once, then the caller can replenish it', async () => {
  const { pool, state } = fixture()
  try {
    pool.prime('session', spec)
    assert.equal(pool.size, 1)
    const handle = pool.take('session')
    assert.ok(handle)
    assert.equal(pool.size, 0)
    assert.equal(pool.take('session'), undefined, 'a claimed worker cannot be shared')
    handle.stdin.end('one request')
    await tick()
    assert.equal(state.requests.at(-1), 'one request')
    pool.prime('session', spec)
    assert.equal(pool.size, 1)
    assert.equal(state.handles.length, 2, 'replenishment spawns exactly one replacement')
  } finally { await pool.dispose() }
})

await test('an already-aborted call never claims an idle worker', async () => {
  const { pool } = fixture()
  try {
    pool.prime('session', spec)
    assert.equal(pool.take('session', AbortSignal.abort()), undefined)
    assert.equal(pool.size, 1, 'the idle worker stays available for a live call')
  } finally { await pool.dispose() }
})

await test('a worker that dies while idle is discarded, so the next call falls back', async () => {
  const { pool, state } = fixture()
  try {
    pool.prime('session', spec)
    state.handles[0].terminate()
    await tick()
    assert.equal(pool.size, 0)
    assert.equal(pool.take('session'), undefined)
  } finally { await pool.dispose() }
})

await test('the idle map is capped and clear terminates without disabling the pool', async () => {
  const { pool, state } = fixture()
  try {
    for (let index = 0; index < 5; index++) pool.prime(`session-${index}`, spec)
    assert.equal(pool.size, 4)
    assert.equal(state.handles.length, 4)
    pool.clear()
    assert.equal(pool.size, 0)
    assert.ok(state.handles.every(handle => handle.terminated))
    pool.prime('later', spec)
    assert.equal(pool.size, 1, 'clear is not dispose')
  } finally { await pool.dispose() }
})

await test('clearSession only terminates that session\'s entries', async () => {
  const { pool, state } = fixture()
  try {
    pool.prime('a', spec, 'a')
    pool.prime('b', spec, 'b')
    pool.clearSession('a')
    assert.equal(pool.size, 1)
    assert.equal(state.handles[0].terminated, true)
    assert.equal(state.handles[1].terminated, false)
  } finally { await pool.dispose() }
})

await test('an idle worker is terminated after its idle TTL', async () => {
  const { pool, state } = fixture({ idleMs: 10 })
  try {
    pool.prime('session', spec)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(pool.size, 0)
    assert.equal(state.handles[0].terminated, true)
  } finally { await pool.dispose() }
})

await test('dispose terminates every idle worker and refuses further priming', async () => {
  const { pool, state } = fixture()
  pool.prime('one', spec)
  pool.prime('two', spec)
  await pool.dispose()
  assert.equal(pool.size, 0)
  assert.ok(state.handles.every(handle => handle.terminated))
  pool.prime('after', spec)
  assert.equal(pool.size, 0)
  assert.equal(state.handles.length, 2)
})

report('warm-worker')
