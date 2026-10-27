import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidKeyEventMeta,
  ScrcpyControlMessageWriter,
} from '@yume-chan/scrcpy'
import type {
  CompositionEvent as ReactCompositionEvent,
  FormEvent as ReactFormEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import ScrcpyClient from './ScrcpyClient'
import contain from 'licia/contain'
import upperCase from 'licia/upperCase'
import isNumeric from 'licia/isNumeric'

export default class Keyboard {
  private controlLeft = false
  private controlRight = false
  private shiftLeft = false
  private shiftRight = false
  private altLeft = false
  private altRight = false
  private metaLeft = false
  private metaRight = false
  private capsLock = false
  private numLock = true
  /**
   * Whether an IME is composing text.
   *
   * While composing, the key events are part of the composition and must
   * not be forwarded to the device, otherwise the pinyin letters would be
   * typed as real key events.
   */
  private composing = false
  /**
   * The text committed by the last IME composition.
   *
   * The browser fires an `input` event with the same text right after the
   * `compositionend` event, it's used to avoid injecting the text twice.
   */
  private committedText: string | null = null
  /**
   * The time when the last IME composition was committed.
   */
  private committedAt = 0
  private readonly client: ScrcpyClient
  constructor(client: ScrcpyClient) {
    this.client = client
  }
  down = async (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()

    // While an IME is composing, the key events are part of the composition
    // and must not be forwarded to the device, otherwise the pinyin letters
    // would be typed as real key events.
    if (e.nativeEvent.isComposing || this.composing) {
      return
    }

    // Right after an IME committed its text, the key event that confirmed
    // the candidate (usually the space key) must not be forwarded either,
    // it would insert a space into the device.
    if (this.isCandidateConfirmKey()) {
      return
    }

    const control = await this.client.getControl()

    const keyCode = this.getKeyCode(e.nativeEvent)
    const controller: ScrcpyControlMessageWriter = control.controller

    if (keyCode) {
      this.setModifier(keyCode, true)

      controller.injectKeyCode({
        action: AndroidKeyEventAction.Down,
        keyCode,
        repeat: 0,
        metaState: this.getMetaState(),
      })
    } else if (e.key.length === 1) {
      controller.injectText(e.key)
    }
  }
  up = async (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.nativeEvent.isComposing || this.composing) {
      return
    }

    const control = await this.client.getControl()

    const keyCode = this.getKeyCode(e.nativeEvent)
    const controller: ScrcpyControlMessageWriter = control.controller

    if (keyCode) {
      this.setModifier(keyCode, false)

      controller.injectKeyCode({
        action: AndroidKeyEventAction.Up,
        keyCode,
        repeat: 0,
        metaState: this.getMetaState(),
      })
    }
  }
  /**
   * Handles the text inserted into the hidden textarea.
   *
   * The `input` event is fired while an IME composition is in progress too
   * (`isComposing` is `true`), those events are ignored, because the
   * composition text is not the text the user committed.
   *
   * A non-composing `input` event means the text was inserted directly
   * (not through an IME composition), it's injected as a text event.
   */
  input = async (e: ReactFormEvent<HTMLTextAreaElement>) => {
    const inputEvent = e.nativeEvent as InputEvent

    const text = e.currentTarget.value

    if (inputEvent.isComposing || this.composing) {
      // The IME is still composing, the textarea must keep its content,
      // otherwise the composition would be broken (the candidate text would
      // be lost and only a space would be committed).
      return
    }

    // The textarea is only used to receive the IME events,
    // reset it for the next composition.
    e.currentTarget.value = ''

    // The browser fires an `input` event with the same text right after
    // the `compositionend` event, it must not be injected twice.
    if (this.committedText !== null) {
      const same = this.committedText === text
      this.committedText = null
      if (same) {
        return
      }
    }

    if (!text) {
      return
    }

    const control = await this.client.getControl()
    const controller: ScrcpyControlMessageWriter = control.controller
    controller.injectText(text)
  }
  /**
   * Handles the start of an IME composition.
   *
   * While composing, the key events are part of the composition and must
   * not be forwarded to the device, otherwise the pinyin letters would be
   * typed as real key events.
   */
  compositionStart = (e: ReactCompositionEvent<HTMLTextAreaElement>) => {
    // NOTE: `preventDefault` must not be called here, it would prevent the
    // `compositionend` event from being fired, and that's the event
    // carrying the text committed by the IME.
    e.stopPropagation()

    // Reset the textarea, so the composition starts from a clean state.
    // It must not be reset while the composition is in progress, otherwise
    // the IME would lose the candidate text.
    e.currentTarget.value = ''

    this.composing = true
  }
  /**
   * Handles the update of an IME composition.
   */
  compositionUpdate = (e: ReactCompositionEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
  }
  /**
   * Handles the end of an IME composition.
   *
   * The `data` of this event is the text committed by the IME, it is injected
   * as a text event, so that the device receives it as if it was typed with
   * a hardware keyboard.
   */
  compositionEnd = async (e: ReactCompositionEvent<HTMLTextAreaElement>) => {
    // NOTE: `preventDefault` must not be called here, it would prevent the
    // `compositionend` event from being fired.
    e.stopPropagation()

    this.composing = false

    // Reset the textarea for the next composition.
    e.currentTarget.value = ''

    const text = e.data
    if (!text) {
      return
    }

    // The browser fires an `input` event with the same text right after
    // this event, and the key event that confirmed the candidate right
    // after that. Remember the text to not be injected twice.
    this.committedText = text
    this.committedAt = Date.now()

    const control = await this.client.getControl()
    const controller: ScrcpyControlMessageWriter = control.controller
    controller.injectText(text)
  }
  /**
   * Whether the given key event is the one that confirmed the candidate of
   * the last IME composition.
   *
   * The key event is fired right after the `compositionend` event, it must
   * not be forwarded to the device, otherwise the space key used to confirm
   * the candidate would insert a space into the device.
   *
   * The time window is used to not swallow the keys typed later.
   */
  private isCandidateConfirmKey(): boolean {
    if (this.committedText === null) {
      return false
    }

    if (Date.now() - this.committedAt > COMMITTED_KEY_TIMEOUT) {
      this.committedText = null
      return false
    }

    this.committedText = null
    return true
  }
  private setModifier(keyCode: AndroidKeyCode, value: boolean) {
    switch (keyCode) {
      case AndroidKeyCode.ControlLeft:
        this.controlLeft = value
        break
      case AndroidKeyCode.ControlRight:
        this.controlRight = value
        break
      case AndroidKeyCode.ShiftLeft:
        this.shiftLeft = value
        break
      case AndroidKeyCode.ShiftRight:
        this.shiftRight = value
        break
      case AndroidKeyCode.AltLeft:
        this.altLeft = value
        break
      case AndroidKeyCode.AltRight:
        this.altRight = value
        break
      case AndroidKeyCode.MetaLeft:
        this.metaLeft = value
        break
      case AndroidKeyCode.MetaRight:
        this.metaRight = value
        break
      case AndroidKeyCode.CapsLock:
        if (value) {
          this.capsLock = !this.capsLock
        }
        break
      case AndroidKeyCode.NumLock:
        if (value) {
          this.numLock = !this.numLock
        }
        break
    }
  }
  private getMetaState(): AndroidKeyEventMeta {
    let metaState = 0

    if (this.altLeft) {
      metaState |= AndroidKeyEventMeta.AltLeft
    }
    if (this.altRight) {
      metaState |= AndroidKeyEventMeta.AltRight
    }
    if (this.shiftLeft) {
      metaState |= AndroidKeyEventMeta.ShiftLeft
    }
    if (this.shiftRight) {
      metaState |= AndroidKeyEventMeta.ShiftRight
    }
    if (this.controlLeft) {
      metaState |= AndroidKeyEventMeta.CtrlLeft
    }
    if (this.controlRight) {
      metaState |= AndroidKeyEventMeta.CtrlRight
    }
    if (this.metaLeft) {
      metaState |= AndroidKeyEventMeta.MetaLeft
    }
    if (this.metaRight) {
      metaState |= AndroidKeyEventMeta.MetaRight
    }
    if (this.capsLock) {
      metaState |= AndroidKeyEventMeta.CapsLock
    }
    if (this.numLock) {
      metaState |= AndroidKeyEventMeta.NumLock
    }

    return metaState as AndroidKeyEventMeta
  }
  private getKeyCode(e: KeyboardEvent): AndroidKeyCode | undefined {
    let code = ''
    const key = e.key

    if (contain(ignoreCodes, e.code)) {
      code = e.code
    }

    if (key.length === 1 && /[a-zA-Z]/.test(key)) {
      if (/[a-zA-Z]/.test(key)) {
        code = `Key${upperCase(key)}`
      } else if (isNumeric(key)) {
        code = `Digit${key}`
      }
    }

    if (keyCodes[key]) {
      code = keyCodes[key]
    }

    return AndroidKeyCode[code as keyof typeof AndroidKeyCode] as
      | AndroidKeyCode
      | undefined
  }
}

/**
 * The maximum time after an IME composition during which the following key
 * event is considered to be the one that confirmed the candidate.
 */
const COMMITTED_KEY_TIMEOUT = 100

const ignoreCodes = [
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'NumLock',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'Backspace',
  'PageUp',
  'PageDown',
  'Escape',
  'Delete',
  'PrintScreen',
  'Pause',
  'Home',
  'End',
  'Insert',
  'NumLock',
]

const keyCodes = {
  ' ': 'Space',
  ';': 'Semicolon',
  '*': 'Star',
  '#': 'Pound',
  ',': 'Comma',
  '.': 'Period',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  "'": 'Quote',
  '/': 'Slash',
  '@': 'At',
  '+': 'Plus',
}
