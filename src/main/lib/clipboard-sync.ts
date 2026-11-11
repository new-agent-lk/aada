import { clipboard, powerMonitor } from 'electron'
import * as window from 'share/main/lib/window'
import log from 'share/common/log'
import isWindows from 'licia/isWindows'
import isMac from 'licia/isMac'

const logger = log('clipboard-sync')

const MAX_TEXT = 1024 * 1024
const POLL_INTERVAL = 500

// The cap is in bytes, so a 1 MiB UTF-8 string with multibyte characters is
// measured the same way the device/protocol sees it (not UTF-16 code units).
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

let timer: ReturnType<typeof setInterval> | null = null
let deviceId = ''
let lastSynced = ''
let paused = false

function pushHostText() {
  if (paused || !deviceId) {
    return
  }
  const text = clipboard.readText()
  if (text === lastSynced) {
    return
  }
  if (byteLength(text) > MAX_TEXT) {
    logger.warn('host clipboard too large, skip', byteLength(text))
    return
  }
  lastSynced = text
  window.sendTo('screencast', 'clipboardFromHost', text)
}

function onSuspend() {
  paused = true
}

function onResume() {
  paused = false
}

export function start(id: string) {
  stop()
  deviceId = id
  paused = false
  // seed so the current host clipboard is not pushed on connect
  lastSynced = clipboard.readText()
  timer = setInterval(pushHostText, POLL_INTERVAL)
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('lock-screen', onSuspend)
  powerMonitor.on('resume', onResume)
  powerMonitor.on('unlock-screen', onResume)
  logger.info('start', id)
}

export function stop() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (deviceId) {
    logger.info('stop', deviceId)
  }
  deviceId = ''
  powerMonitor.removeListener('suspend', onSuspend)
  powerMonitor.removeListener('lock-screen', onSuspend)
  powerMonitor.removeListener('resume', onResume)
  powerMonitor.removeListener('unlock-screen', onResume)
}

export function setEnabled(options: { enabled: boolean; deviceId?: string }) {
  if (options.enabled && options.deviceId) {
    start(options.deviceId)
  } else {
    stop()
  }
}

// Device -> host: write the text the device put on its clipboard.
export function writeFromDevice(text: string) {
  if (!deviceId) {
    return
  }
  if (!text || byteLength(text) > MAX_TEXT) {
    logger.warn('device clipboard empty or too large, skip', byteLength(text))
    return
  }
  lastSynced = text
  clipboard.writeText(text)
}

function fileUrlToPath(s: string): string {
  if (s.startsWith('file://')) {
    let p = decodeURIComponent(s.slice('file://'.length))
    if (/^\/[a-zA-Z]:/.test(p)) {
      p = p.slice(1)
    }
    return p
  }
  return s
}

function splitNullPaths(text: string): string[] {
  return text
    .split('\u0000')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function readWindowsFiles(): string[] {
  const formats = clipboard.availableFormats()
  if (formats.includes('FileNameW')) {
    const buf = clipboard.readBuffer('FileNameW')
    if (buf && buf.length) {
      return splitNullPaths(buf.toString('utf16le'))
    }
  }
  if (formats.includes('CF_HDROP')) {
    const buf = clipboard.readBuffer('CF_HDROP')
    if (buf && buf.length >= 20) {
      const offset = buf.readUInt32LE(0)
      return splitNullPaths(buf.subarray(offset).toString('utf16le'))
    }
  }
  return []
}

function readMacFiles(): string[] {
  const formats = clipboard.availableFormats()
  // Multiple files arrive as a plist under NSFilenamesPboardType; public.file-url
  // only carries one. Pull every <string> path out of the plist when present.
  if (formats.includes('NSFilenamesPboardType')) {
    const raw = clipboard.read('NSFilenamesPboardType')
    if (raw) {
      const paths = Array.from(raw.matchAll(/<string>([^<]*)<\/string>/g))
        .map((m) => m[1].trim())
        .filter((p) => p.length > 0)
      if (paths.length) {
        return paths
      }
    }
  }
  if (formats.includes('public.file-url')) {
    const raw = clipboard.read('public.file-url')
    if (raw) {
      return [fileUrlToPath(raw.trim())]
    }
  }
  return []
}

function readLinuxFiles(): string[] {
  const formats = clipboard.availableFormats()
  const result: string[] = []
  const addUri = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t === 'copy' || t === 'cut' || t.startsWith('#')) {
        continue
      }
      result.push(fileUrlToPath(t))
    }
  }
  if (formats.includes('x-special/gnome-copied-files')) {
    const raw = clipboard.read('x-special/gnome-copied-files')
    if (raw) {
      addUri(raw)
    }
  } else if (formats.includes('text/uri-list')) {
    const raw = clipboard.read('text/uri-list')
    if (raw) {
      addUri(raw)
    }
  }
  return result
}

export async function getClipboardFiles(): Promise<string[]> {
  try {
    if (isWindows) {
      return readWindowsFiles()
    }
    if (isMac) {
      return readMacFiles()
    }
    return readLinuxFiles()
  } catch (err) {
    logger.warn('get clipboard files failed', err)
    return []
  }
}
