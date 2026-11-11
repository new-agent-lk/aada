import fs from 'fs-extra'
import path from 'path'
import { getUserDataPath, resolveResources } from 'share/main/lib/util'
import log from 'share/common/log'
import { compareVersion, isVersionName } from './scrcpy-version'
import manifest from './scrcpy-version.json'

const logger = log('scrcpy-updater')

const RELEASES_URL =
  'https://api.github.com/repos/Genymobile/scrcpy/releases/latest'

export interface ScrcpyVersions {
  bundled: string
  installed: string
  latest: string
  maxSupported: string
}

function getInstallDir(version: string) {
  return getUserDataPath(path.join('scrcpy', version))
}

// The version the bundled resources/scrcpy.jar actually is. Prefer the sidecar
// written by `npm run scrcpy`; fall back to the manifest when it is missing.
function readBundledVersion(): string {
  try {
    const v = fs.readFileSync(resolveResources('scrcpy.version'), 'utf8').trim()
    if (isVersionName(v)) {
      return v
    }
  } catch {
    // sidecar not present (older build)
  }
  return manifest.bundled
}

// Startup guard: the shipped jar and the manifest must agree, otherwise the
// server is launched with a version string its jar does not match and aborts.
export function assertManifestConsistency(): void {
  const actual = readBundledVersion()
  if (actual !== manifest.bundled) {
    logger.warn(
      `manifest bundled ${manifest.bundled} != jar version ${actual}; using jar version`
    )
  }
  if (compareVersion(actual, manifest.maxSupported) > 0) {
    logger.warn(
      `bundled scrcpy ${actual} is newer than the client supports (${manifest.maxSupported})`
    )
  }
}

// Pick the highest installed jar that the client still supports, else the bundled one.
export function resolveJarVersion(): { version: string; path: string } {
  const root = getUserDataPath('scrcpy')
  let best = ''
  try {
    for (const name of fs.readdirSync(root)) {
      if (!isVersionName(name)) {
        continue
      }
      if (compareVersion(name, manifest.maxSupported) > 0) {
        continue
      }
      if (fs.existsSync(path.join(root, name, 'scrcpy.jar'))) {
        if (!best || compareVersion(name, best) > 0) {
          best = name
        }
      }
    }
  } catch {
    // no user dir yet
  }

  if (best) {
    return { version: best, path: path.join(root, best, 'scrcpy.jar') }
  }

  return { version: readBundledVersion(), path: resolveResources('scrcpy.jar') }
}

export async function checkLatest(): Promise<{
  version: string
  assetUrl: string
}> {
  const res = await fetch(RELEASES_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'aya',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    throw new Error(`GitHub HTTP ${res.status}`)
  }
  const data: any = await res.json()
  const version = String(data.tag_name || '').replace(/^v/, '')
  if (!version) {
    throw new Error('No tag_name in release')
  }
  const asset = (data.assets || []).find(
    (a: any) => a.name === `scrcpy-server-v${version}`
  )
  const assetUrl = asset
    ? asset.browser_download_url
    : `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}`
  return { version, assetUrl }
}

export async function getVersions(): Promise<ScrcpyVersions> {
  const current = resolveJarVersion()
  let latest = ''
  try {
    latest = (await checkLatest()).version
  } catch (err) {
    logger.warn('check latest failed', err)
  }
  return {
    bundled: readBundledVersion(),
    installed: current.version,
    latest,
    maxSupported: manifest.maxSupported,
  }
}

export async function install(version: string): Promise<void> {
  if (compareVersion(version, manifest.maxSupported) > 0) {
    throw new Error(
      `scrcpy ${version} is newer than the client supports (${manifest.maxSupported})`
    )
  }

  const url = `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}`
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) {
    throw new Error(`download HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  // Guard against an error page or truncated download being installed as a jar:
  // a real scrcpy-server is a ZIP (PK\x03\x04) of a few hundred KB.
  if (buf.length < 100 * 1024) {
    throw new Error(`downloaded jar too small (${buf.length} bytes)`)
  }
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('downloaded file is not a jar (bad magic)')
  }

  const dir = getInstallDir(version)
  await fs.ensureDir(dir)
  const tmp = path.join(dir, `.scrcpy.jar.${Date.now()}.tmp`)
  await fs.writeFile(tmp, buf)
  await fs.rename(tmp, path.join(dir, 'scrcpy.jar'))
  logger.info('installed', version, buf.length)
}

// Startup: install the latest release when it is newer and still supported.
export async function autoCheck(): Promise<void> {
  try {
    const { version } = await checkLatest()
    if (
      compareVersion(version, readBundledVersion()) > 0 &&
      compareVersion(version, manifest.maxSupported) <= 0
    ) {
      await install(version)
    }
  } catch (err) {
    logger.warn('auto check failed', err)
  }
}
