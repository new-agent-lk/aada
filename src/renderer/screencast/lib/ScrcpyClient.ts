import type net from 'node:net'
import lpad from 'licia/lpad'
import Emitter from 'licia/Emitter'
import log from 'share/common/log'
import {
  ScrcpyOptions4_0,
  ScrcpyVideoCodecId,
  ScrcpyAudioCodec,
  ScrcpyControlMessageWriter,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  AndroidKeyEventAction,
  AndroidKeyCode,
  ScrcpyMediaStreamDataPacket,
  ScrcpyVideoStreamPacket,
} from '@yume-chan/scrcpy'
import {
  InspectStream,
  WritableStream,
  ReadableStream,
  TransformStream,
  BufferedReadableStream,
  PushReadableStream,
  Consumable,
  ReadableWritablePair,
} from '@yume-chan/stream-extra'
import {
  WebCodecsVideoDecoder,
  InsertableStreamVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs'
import { Float32PcmPlayer } from '@yume-chan/pcm-player'
import { getUint32BigEndian } from '@yume-chan/no-data-view'
import Readiness from 'licia/Readiness'
import { OpusStream } from './AudioStream'
import sleep from 'licia/sleep'
import { socketToReadableStream, socketToReadableWritablePair } from './util'
import clamp from 'licia/clamp'
import Recorder from './Recorder'
import convertBin from 'licia/convertBin'
import dateFormat from 'licia/dateFormat'
import noop from 'licia/noop'
import Keyboard from './Keyboard'
import isUndef from 'licia/isUndef'

const logger = log('ScrcpyClient')

export default class ScrcpyClient extends Emitter {
  private deviceId: string
  private server?: net.Server
  private video: any
  private audio: any
  private control: any
  private options: ScrcpyOptions4_0<ScrcpyOptions4_0.Init>
  private readiness = new Readiness()
  private recorder = new Recorder()
  private keyboard = new Keyboard(this)
  /**
   * The hidden textarea used as the IME target.
   */
  private imeProxy?: HTMLTextAreaElement
  constructor(
    deviceId: string,
    options: ScrcpyOptions4_0<ScrcpyOptions4_0.Init>
  ) {
    super()

    this.options = options
    this.deviceId = deviceId

    this.start()
  }
  async getVideo() {
    await this.readiness.ready('video')
    return this.video
  }
  async getControl() {
    await this.readiness.ready('control')
    return this.control
  }
  /**
   * The keyboard event handlers, used by the IME proxy element.
   */
  get keyboardHandlers() {
    return {
      onInput: this.keyboard.input,
      onKeyDown: this.keyboard.down,
      onKeyUp: this.keyboard.up,
      onCompositionStart: this.keyboard.compositionStart,
      onCompositionUpdate: this.keyboard.compositionUpdate,
      onCompositionEnd: this.keyboard.compositionEnd,
    }
  }
  /**
   * Registers the hidden textarea used as the IME target.
   */
  setImeProxy(element: HTMLTextAreaElement | null) {
    this.imeProxy = element ?? undefined
  }
  destroy() {
    logger.info('destroy')

    if (this.server) {
      this.server.close()
    }
  }
  startRecording() {
    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.resetVideo()
    }
    this.recorder.start()
  }
  async stopRecording() {
    const buf = this.recorder.stop()
    if (buf) {
      const { canceled, filePath } = await main.showSaveDialog({
        defaultPath: `recording-${dateFormat('yyyymmddHHMM')}.mkv`,
      })
      if (canceled) {
        return
      }
      await node.writeFile(filePath, convertBin(buf, 'Uint8Array'))
    }
  }
  async turnOffScreen() {
    await this.readiness.ready('control')
    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.setDisplayPower(false)
    }
  }
  async turnOnScreen() {
    await this.readiness.ready('control')
    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.setDisplayPower(true)
    }
  }
  async setClipboard(text: string, paste = false) {
    await this.readiness.ready('control')
    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.setClipboard({
        sequence: 0n,
        content: text,
        paste,
      })
    }
  }
  private start = async () => {
    const { deviceId, options } = this

    const port = await main.reverseTcp(
      this.deviceId,
      `localabstract:scrcpy_${lpad(options.value.scid as string, 8, '0')}`
    )

    const server = node.createServer(async (socket) => {
      // video socket is the first connection
      if (!this.video) {
        this.video = {}
        this.createVideo(socketToReadableStream(socket))
        socket.on('close', () => this.emit('close'))
        return
      }

      // audio socket and control socket orders are not guaranteed, need to detect
      let isAudio = false
      this.detectAudioStream(socketToReadableStream(socket)).then((value) => {
        // never resolve if it's control socket
        if (value.audio) {
          isAudio = true
          this.createAudio(value.stream)
        }
      })
      sleep(1000).then(() => {
        if (!isAudio) {
          this.createControl(socketToReadableWritablePair(socket))
        }
      })
    })
    server.listen(port)
    this.server = server

    main.startScrcpy(deviceId, options.serialize())
  }
  private async detectAudioStream(stream: ReadableStream<Uint8Array>) {
    let isAudio = false

    const buffered = new BufferedReadableStream(stream)
    const buffer = await buffered.readExactly(4)
    const codecMetadataValue = getUint32BigEndian(buffer, 0)

    const readableStream = new PushReadableStream<Uint8Array>(
      async (controller) => {
        await controller.enqueue(buffer)

        const stream = buffered.release()
        const reader = stream.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          await controller.enqueue(value)
        }
      }
    )
    switch (codecMetadataValue) {
      case 0x00_00_00_00:
      case ScrcpyAudioCodec.Opus.metadataValue:
        isAudio = true
        break
    }

    if (isAudio) {
      return {
        audio: true,
        stream: readableStream,
      }
    }

    return {
      audio: false,
      stream: readableStream,
    }
  }
  private async createVideo(videoStream: ReadableStream<Uint8Array>) {
    logger.info('video stream connected')

    const { options } = this

    const { stream, metadata } = await options.parseVideoStreamMetadata(
      videoStream
    )

    logger.info('video metadata', metadata)
    this.recorder.videoMetadata = metadata

    let codec: any = 0
    switch (metadata.codec) {
      case ScrcpyVideoCodecId.H264:
        codec = ScrcpyVideoCodecId.H264
        break
    }
    const renderer = new InsertableStreamVideoFrameRenderer(undefined, {
      // Keep `element.width`/`element.height` in sync with the video size,
      // they are used to calculate the pointer coordinates.
      updateSize: true,
    })
    const decoder = new WebCodecsVideoDecoder({
      codec,
      renderer,
    })

    this.video = {
      stream: stream
        .pipeThrough(options.createMediaStreamTransformer())
        .pipeThrough(
          new InspectStream((packet: ScrcpyVideoStreamPacket) => {
            this.recorder.addVideoPacket(packet)
            if (packet.type === 'configuration') {
              logger.info('video configuration', packet.data)
            }
            return undefined
          })
        )
        // Since scrcpy 4.0, the video stream contains "session" packets
        // carrying the video size. They aren't media data, so they must not
        // be passed to the decoder.
        .pipeThrough(
          new TransformStream<ScrcpyVideoStreamPacket, ScrcpyVideoStreamPacket>(
            {
              transform(packet, controller) {
                if (packet.type === 'session') {
                  return
                }
                controller.enqueue(packet)
              },
            }
          )
        ),
      metadata,
      decoder,
    }

    this.bindVideoEvent(renderer.element)

    logger.info('video ready')
    this.readiness.signal('video')
  }
  private bindVideoEvent(el: HTMLVideoElement) {
    logger.info('bind video event')

    el.addEventListener('pointerdown', (e) => {
      // Keep the focus on the IME proxy, so the system IME keeps working
      this.imeProxy?.focus()
      if (e.button === 0) {
        this.injectTouch(el, e)
      } else {
        this.injectKeyCode(e)
      }
    })
    el.addEventListener('pointermove', (e) => this.injectTouch(el, e))
    el.addEventListener('pointerup', (e) => {
      if (e.button === 0) {
        this.injectTouch(el, e)
      } else {
        this.injectKeyCode(e)
      }
    })

    el.addEventListener('wheel', (e) => this.injectScroll(el, e))

    // The keyboard events are handled by the IME proxy element,
    // so the video element doesn't need to be focusable.
    el.setAttribute('tabindex', '-1')
  }
  private injectKeyCode(e: PointerEvent) {
    e.preventDefault()
    e.stopPropagation()

    const actionMap = {
      pointerdown: AndroidKeyEventAction.Down,
      pointerup: AndroidKeyEventAction.Up,
    }
    const action = actionMap[e.type]
    if (isUndef(action)) {
      return
    }

    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.injectKeyCode({
        action,
        keyCode: MouseEventButtonToAndroidButton[e.button - 1],
        repeat: 0,
        metaState: 0,
      })
    }
  }
  private injectScroll(el: HTMLVideoElement, e: WheelEvent) {
    e.preventDefault()
    e.stopPropagation()

    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.injectScroll({
        ...this.getPointer(el, e.clientX, e.clientY),
        scrollX: -e.deltaX / 100,
        scrollY: -e.deltaY / 100,
        buttons: 0,
      })
    }
  }
  private getPointer(el: HTMLVideoElement, clientX: number, clientY: number) {
    const videoWidth = el.width
    const videoHeight = el.height

    const rect = el.getBoundingClientRect()

    const videoRect = {
      width: 0,
      height: 0,
      x: 0,
      y: 0,
    }
    if (videoWidth / videoHeight < rect.width / rect.height) {
      videoRect.height = rect.height
      videoRect.width = videoRect.height * (videoWidth / videoHeight)
      videoRect.x = rect.x + (rect.width - videoRect.width) / 2
      videoRect.y = rect.y
    } else {
      videoRect.width = rect.width
      videoRect.height = videoRect.width * (videoHeight / videoWidth)
      videoRect.x = rect.x
      videoRect.y = rect.y + (rect.height - videoRect.height) / 2
    }

    const percentageX = clamp((clientX - videoRect.x) / videoRect.width, 0, 1)
    const percentageY = clamp((clientY - videoRect.y) / videoRect.height, 0, 1)

    const pointerX = percentageX * videoWidth
    const pointerY = percentageY * videoHeight

    return {
      videoWidth,
      videoHeight,
      pointerX,
      pointerY,
    }
  }
  private injectTouch(el: HTMLVideoElement, e: PointerEvent) {
    e.preventDefault()
    e.stopPropagation()

    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)

    const { type, clientX, clientY, button, buttons } = e

    let action: AndroidMotionEventAction
    switch (type) {
      case 'pointerdown':
        action = AndroidMotionEventAction.Down
        break
      case 'pointermove':
        if (buttons === 0) {
          action = AndroidMotionEventAction.HoverMove
        } else {
          action = AndroidMotionEventAction.Move
        }
        break
      case 'pointerup':
        action = AndroidMotionEventAction.Up
        break
      default:
        throw new Error(`Unsupported event type: ${type}`)
    }

    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.injectTouch({
        action,
        pointerId: BigInt(e.pointerId),
        ...this.getPointer(el, clientX, clientY),
        pressure: buttons === 0 ? 0 : 1,
        actionButton: PointerEventButtonToAndroidButton[button],
        buttons,
      })
    }
  }
  private async createAudio(audioStream: ReadableStream<Uint8Array>) {
    logger.info('audio stream connected')

    const { options } = this

    const metadata = await options.parseAudioStreamMetadata(audioStream)

    logger.info('audio metadata', metadata)

    if (metadata.type !== 'success') {
      this.audio = metadata
    } else {
      this.audio = {
        ...metadata,
        stream: metadata.stream.pipeThrough(
          options.createMediaStreamTransformer()
        ),
      }

      const [recordStream, playbackStream] = this.audio.stream.tee()

      let player: any
      if (metadata.codec === ScrcpyAudioCodec.Raw) {
        logger.info('audio codec raw')
      } else if (metadata.codec === ScrcpyAudioCodec.Opus) {
        logger.info('audio codec opus')
        player = new Float32PcmPlayer(48000, 2)
        playbackStream
          .pipeThrough(
            new OpusStream({
              codec: metadata.codec.webCodecId,
              numberOfChannels: 2,
              sampleRate: 48000,
            })
          )
          .pipeTo(
            new WritableStream({
              write: (chunk) => {
                player.feed(chunk)
              },
            })
          )

        player.start()
      }

      this.recorder.audioCodec = metadata.codec

      recordStream.pipeTo(
        new WritableStream({
          write: (packet: ScrcpyMediaStreamDataPacket) => {
            if (packet.type === 'data') {
              this.recorder.addAudioPacket(packet)
            }
          },
        })
      )
    }

    logger.info('audio ready')
    this.readiness.signal('audio')
  }
  private async createControl(
    controlStream: ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>
  ) {
    logger.info('control stream connected')

    const { options } = this

    const controller = new ScrcpyControlMessageWriter(
      controlStream.writable.getWriter(),
      options
    )

    options.clipboard!.pipeTo(
      new WritableStream({
        write: (content) => {
          navigator.clipboard.writeText(content)
        },
      })
    )
    this.parseDeviceMessages(controlStream.readable).catch(noop)

    this.control = {
      controller,
    }

    logger.info('control ready')
    this.readiness.signal('control')
  }
  private async parseDeviceMessages(controlStream: ReadableStream<Uint8Array>) {
    const buffered = new BufferedReadableStream(controlStream)
    const parsers = this.options.deviceMessageParsers
    try {
      while (true) {
        let type: number
        try {
          const result = await buffered.readExactly(1)
          type = result[0]!
        } catch {
          parsers.close()
          break
        }
        await parsers.parse(type, buffered)
      }
    } catch (e) {
      parsers.error(e)
      buffered.cancel(e).catch(() => {})
    }
  }
}

const PointerEventButtonToAndroidButton: AndroidMotionEventButton[] = [
  AndroidMotionEventButton.Primary,
  AndroidMotionEventButton.Tertiary,
  AndroidMotionEventButton.Secondary,
  AndroidMotionEventButton.Back,
  AndroidMotionEventButton.Forward,
]

const MouseEventButtonToAndroidButton: AndroidKeyCode[] = [
  AndroidKeyCode.AndroidHome,
  AndroidKeyCode.AndroidBack,
]
