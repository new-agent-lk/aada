import { useEffect, useRef } from 'react'
import type {
  CompositionEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
} from 'react'
import Style from './ImeProxy.module.scss'

/**
 * A hidden textarea used as the IME (input method editor) target.
 *
 * A `<video>` element never receives IME composition events, so the system
 * IME can't be used to type text into the device. A focused, editable
 * element is required for the IME to be able to compose text, and the
 * committed text is then read from this textarea.
 *
 * It is positioned outside of the viewport, so it never affects the layout,
 * but it must not be `display: none` or `visibility: hidden`, otherwise
 * it can't be focused and won't receive any event.
 */
export default function ImeProxy(props: {
  onInput: FormEventHandler<HTMLTextAreaElement>
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  onKeyUp: KeyboardEventHandler<HTMLTextAreaElement>
  onCompositionStart: CompositionEventHandler<HTMLTextAreaElement>
  onCompositionUpdate: CompositionEventHandler<HTMLTextAreaElement>
  onCompositionEnd: CompositionEventHandler<HTMLTextAreaElement>
  onRef?: (element: HTMLTextAreaElement | null) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <textarea
      ref={(element) => {
        ref.current = element
        props.onRef?.(element)
      }}
      className={Style.imeProxy}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      onInput={props.onInput}
      onKeyDown={props.onKeyDown}
      onKeyUp={props.onKeyUp}
      onCompositionStart={props.onCompositionStart}
      onCompositionUpdate={props.onCompositionUpdate}
      onCompositionEnd={props.onCompositionEnd}
    />
  )
}
