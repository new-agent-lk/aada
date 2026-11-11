// Version helpers for the scrcpy updater, kept dependency-free so
// script/selftest.mjs can exercise them without Electron.

export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((v) => parseInt(v, 10) || 0)
  const pb = b.split('.').map((v) => parseInt(v, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) {
      return x - y
    }
  }
  return 0
}

// Only plain dotted-numeric names are versions, so a stray directory such as
// "scrcpy.jar.tmp" is never mistaken for an installed release.
export function isVersionName(s: string): boolean {
  return /^\d+(\.\d+)*$/.test(s)
}
