// Assert-based self-check for the pure security/version helpers. Run with
// `npm test` (Node 24 strips the TypeScript types on import).
import assert from 'node:assert/strict'
import { assertSafePath, quoteShellArg } from '../src/main/lib/adb/path-utils.ts'
import {
  compareVersion,
  isVersionName,
} from '../src/main/lib/scrcpy-version.ts'
import { uniqueName } from '../src/common/unique-name.ts'

// assertSafePath: reject traversal / NUL, accept normal paths.
for (const bad of [
  '/sdcard/../etc/passwd',
  '/data/data/com.x/../../../',
  'a\u0000b',
  '',
]) {
  assert.throws(() => assertSafePath(bad), /Unsafe path/, `should reject: ${bad}`)
}
for (const ok of ['/sdcard/a.txt', '/data/local/tmp/', 'C:\\Users\\me\\a', '/']) {
  assert.doesNotThrow(() => assertSafePath(ok), `should accept: ${ok}`)
}

// quoteShellArg: single-quote and escape embedded quotes.
assert.equal(quoteShellArg("a b'c"), "'a b'\\''c'")
assert.equal(quoteShellArg('$(id)'), "'$(id)'")
assert.equal(quoteShellArg('a`id`b'), "'a`id`b'")

// compareVersion: numeric, not lexical.
assert.ok(compareVersion('5.0.1', '5.0.0') > 0)
assert.ok(compareVersion('4.1', '5.0.1') < 0)
assert.equal(compareVersion('5.0.1', '5.0.1'), 0)
assert.ok(compareVersion('10.0', '9.9') > 0)

// isVersionName: only dotted-numeric names.
for (const ok of ['5.0.1', '4.1', '10']) {
  assert.ok(isVersionName(ok), `should be version: ${ok}`)
}
for (const bad of ['scrcpy.jar.tmp', 'foo', '', '5.0.1.tmp', '.5']) {
  assert.ok(!isVersionName(bad), `should not be version: ${bad}`)
}

// uniqueName: no collision keeps the name, else appends " (n)" before the ext.
assert.equal(uniqueName([], 'a.txt'), 'a.txt')
assert.equal(uniqueName([{ name: 'a.txt' }], 'a.txt'), 'a (1).txt')
assert.equal(
  uniqueName([{ name: 'a.txt' }, { name: 'a (1).txt' }], 'a.txt'),
  'a (2).txt'
)
assert.equal(uniqueName([{ name: 'b' }], 'b'), 'b (1)')

console.log('selftest ok')
