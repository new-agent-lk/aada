// Pure path helpers for the ADB file layer, kept dependency-free so
// script/selftest.mjs can exercise them without Electron/ADB.

// Reject NUL bytes and `..` segments so a renderer-supplied path cannot escape
// the directory the user is looking at (ported from rustdesk's traversal guard).
export function assertSafePath(
  p: string,
  warn?: (message: string, path: string) => void
): void {
  const reject = (message: string) => {
    if (warn) {
      warn(message, p)
    }
    throw new Error(`Unsafe path: ${p}`)
  }
  if (!p || p.includes('\0')) {
    reject('rejected unsafe path')
  }
  const segments = p.split(/[\\/]+/)
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '..') {
      reject('rejected path traversal')
    }
  }
}

// Single-quote a value for the device shell so spaces/metacharacters in a file
// name cannot break out of the argument.
export function quoteShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'"
}
