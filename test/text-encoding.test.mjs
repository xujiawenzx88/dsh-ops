/** Text encoding through the real worker: GB18030 and BOM-marked UTF-16 are text. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('text-encoding')
const call = async (tool, args, root) => envelopeOf(await callTool(tool, args, { root }), assert)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const gb = (...parts) => Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)))
const utf16 = (text, endian = 'le') => { const bytes = Buffer.from(text, 'utf16le'); return endian === 'be' ? bytes.swap16() : bytes }

await test('GB18030 text reads, edits and overwrites without changing its codec', async () => {
  await withTempDir('encoding-gb18030', async root => {
    const target = path.join(root, 'notes.txt')
    const bytes = gb('head\n', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), ' tail\n')
    fs.writeFileSync(target, bytes)
    const read = await call('inspect_local_file', { path: target }, root)
    assert.equal(read.status, 'completed', JSON.stringify(read))
    assert.equal(read.revision, hash(bytes))
    assert.equal(read.lineCount, 2)
    assert.deepEqual(read.items.map(item => [item.line, item.text]), [[1, 'head'], [2, '中文 tail']])
    const stat = await call('stat', { path: target }, root)
    assert.equal(stat.lineCount, 2)
    assert.equal(stat.revision, hash(bytes))
    const edit = await call('edit_file', { path: target, expectedRevision: hash(bytes), edits: [{ oldText: '中文', newText: '汉字' }] }, root)
    assert.equal(edit.status, 'completed', JSON.stringify(edit))
    assert.equal(edit.changed, 1)
    const edited = gb('head\n', Buffer.from([0xba, 0xba, 0xd7, 0xd6]), ' tail\n')
    assert.deepEqual(fs.readFileSync(target), edited, 'untouched bytes keep their GB18030 encoding')
    assert.equal(edit.revision, hash(edited))
    const write = await call('write_file', { path: target, content: '正文\n', expectedRevision: hash(edited) }, root)
    assert.equal(write.status, 'completed', JSON.stringify(write))
    assert.deepEqual(fs.readFileSync(target), Buffer.from([0xd5, 0xfd, 0xce, 0xc4, 0x0a]), 'an overwrite of an existing file keeps GB18030')
    assert.equal(write.lineCount, 1)
  })
})

await test('diff compares decoded GB18030 text and hashes what a write would publish', async () => {
  await withTempDir('encoding-diff', async root => {
    const target = path.join(root, 'diff.txt')
    const bytes = gb(Buffer.from([0xd6, 0xd0]), '\n')
    fs.writeFileSync(target, bytes)
    const value = await call('diff', { path: target, content: '中\n文\n' }, root)
    assert.equal(value.status, 'completed', JSON.stringify(value))
    assert.equal(value.before.revision, hash(bytes))
    assert.equal(value.after.revision, hash(gb(Buffer.from([0xd6, 0xd0]), '\n', Buffer.from([0xce, 0xc4]), '\n')))
    assert.equal(value.after.lineCount, 2)
    assert.deepEqual(value.items, [{ kind: 'add', line: 2, text: '文\n' }])
  })
})

await test('BOM-marked UTF-16LE stays UTF-16LE through inspect and edit', async () => {
  await withTempDir('encoding-utf16le', async root => {
    const target = path.join(root, 'le.txt')
    const bytes = gb(Buffer.from([0xff, 0xfe]), utf16('a\n你\n'))
    fs.writeFileSync(target, bytes)
    const read = await call('inspect_local_file', { path: target }, root)
    assert.equal(read.status, 'completed', JSON.stringify(read))
    assert.equal(read.revision, hash(bytes))
    assert.equal(read.lineCount, 2)
    assert.deepEqual(read.items.map(item => item.text), ['\uFEFFa', '你'])
    const edit = await call('edit_file', { path: target, expectedRevision: hash(bytes), edits: [{ oldText: '你', newText: '好' }] }, root)
    assert.equal(edit.status, 'completed', JSON.stringify(edit))
    assert.deepEqual(fs.readFileSync(target), gb(Buffer.from([0xff, 0xfe]), utf16('a\n好\n')), 'the BOM survives as an ordinary character')
  })
})

await test('overwriting a BOM-marked UTF-16BE file re-attaches its BOM', async () => {
  await withTempDir('encoding-utf16be', async root => {
    const target = path.join(root, 'be.txt')
    const bytes = gb(Buffer.from([0xfe, 0xff]), utf16('α\n', 'be'))
    fs.writeFileSync(target, bytes)
    const write = await call('write_file', { path: target, content: 'β\n', expectedRevision: hash(bytes) }, root)
    assert.equal(write.status, 'completed', JSON.stringify(write))
    assert.equal(write.changed, 1)
    assert.deepEqual(fs.readFileSync(target), gb(Buffer.from([0xfe, 0xff]), utf16('β\n', 'be')), 'a plain overwrite cannot strip the only encoding marker')
    assert.equal(write.lineCount, 1)
  })
})

await test('read_many decodes each file and reports a binary sibling alone', async () => {
  await withTempDir('encoding-many', async root => {
    const gbFile = path.join(root, 'gb.txt'); fs.writeFileSync(gbFile, gb(Buffer.from([0xd6, 0xd0]), '\n'))
    const leFile = path.join(root, 'le.txt'); fs.writeFileSync(leFile, gb(Buffer.from([0xff, 0xfe]), utf16('你')))
    const binary = path.join(root, 'binary'); fs.writeFileSync(binary, Buffer.from([0xff, 0x61]))
    const body = await call('read_many', { files: [{ path: gbFile }, { path: leFile }, { path: binary }] }, root)
    assert.equal(body.status, 'partial', JSON.stringify(body))
    assert.equal(body.failed, 1)
    assert.equal(body.items[0].items[0].text, '中')
    assert.deepEqual(body.items[1].items.map(item => item.text), ['\uFEFF你'])
    assert.equal(body.items[2].error.code, 'ERR_INVALID_ENCODING')
    assert.equal(body.items[2].error.effectState, 'none')
    assert.deepEqual(body.items[2].items, [])
  })
})

await test('explicit encodings are strict and unrepresentable characters refuse the write', async () => {
  await withTempDir('encoding-strict', async root => {
    const target = path.join(root, 'gb.txt')
    const bytes = gb(Buffer.from([0xd6, 0xd0]), '\n')
    fs.writeFileSync(target, bytes)
    const mismatched = await call('inspect_local_file', { path: target, encoding: 'utf-16le' }, root)
    assert.equal(mismatched.status, 'error', JSON.stringify(mismatched))
    assert.equal(mismatched.error.code, 'ERR_INVALID_ENCODING')
    assert.equal(mismatched.error.effectState, 'none')
    const forced = await call('inspect_local_file', { path: target, encoding: 'gb18030' }, root)
    assert.equal(forced.status, 'completed', JSON.stringify(forced))
    assert.equal(forced.items[0].text, '中')
    const refused = await call('write_file', { path: target, content: '\uE5E5\n', expectedRevision: hash(bytes) }, root)
    assert.equal(refused.status, 'error', JSON.stringify(refused))
    assert.equal(refused.error.code, 'ERR_INVALID_ENCODING')
    assert.equal(refused.error.effectState, 'none')
    assert.deepEqual(fs.readFileSync(target), bytes, 'the refused overwrite published nothing')
    assert.deepEqual(fs.readdirSync(root), ['gb.txt'], 'the refusal left no sidecar')
  })
})
report('text-encoding')
