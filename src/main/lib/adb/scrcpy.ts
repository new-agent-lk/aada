import { Client } from '@devicefarmer/adbkit'
import { handleEvent } from 'share/main/lib/util'
import { getDeviceStore, setDeviceStore } from './base'
import { resolveJarVersion } from '../scrcpy-updater'
import log from 'share/common/log'
import { IpcStartScrcpy } from 'common/types'

const logger = log('scrcpy')

let client: Client

class ScrcpyClient {
  private deviceId = ''
  constructor(deviceId: string) {
    this.deviceId = deviceId
  }
  async start(args: string[]) {
    const jar = resolveJarVersion()
    await this.push(jar.path)

    logger.info('start', args)

    const device = client.getDevice(this.deviceId)
    const socket = await device.shell(
      `CLASSPATH=/data/local/tmp/aya/scrcpy.jar app_process /system/bin com.genymobile.scrcpy.Server ${jar.version} ${args.join(
        ' '
      )}`
    )
    socket.on('readable', () => {
      const data = socket.read()
      if (data) {
        logger.info(data.toString())
      }
    })
  }
  async push(jarPath: string) {
    logger.info('push')

    const device = client.getDevice(this.deviceId)
    await device.push(jarPath, '/data/local/tmp/aya/scrcpy.jar')
  }
}

async function getScrcpyClient(deviceId: string): Promise<ScrcpyClient> {
  let scrcpyClient = getDeviceStore(deviceId, 'scrcpyClient')
  if (!scrcpyClient) {
    scrcpyClient = new ScrcpyClient(deviceId)
    setDeviceStore(deviceId, 'scrcpyClient', scrcpyClient)
  }
  return scrcpyClient
}

const startScrcpy: IpcStartScrcpy = async function (deviceId, args) {
  const client = await getScrcpyClient(deviceId)
  await client.start(args)
}

export async function init(c: Client) {
  client = c

  handleEvent('startScrcpy', startScrcpy)
}
