# AYA — Safe upgrade path for the scrcpy stack (→ scrcpy-server v5.0.1)

Researched: 2026-11-11. Repo: `/media/kang/myworkspace/aada` (AYA 1.14.2, Electron + `@yume-chan/scrcpy` client, `@devicefarmer/adbkit` transport).

## TL;DR (recommended)

**Pair `scrcpy-server v5.0.1` with `@yume-chan/scrcpy 3.0.0-beta.5` and switch the client options class from `ScrcpyOptions4_0` to `ScrcpyOptions5_0_1`.**

- This is safe because the library's `ScrcpyOptions5_0_1` is a **type-alias of the real `ScrcpyOptions4_1` implementation** — i.e. the author declares the client wire protocol unchanged from scrcpy-server 4.1 through 5.0.1.
- **Zero-dependency-churn variant:** AYA's already-installed `3.0.0-beta.4` *also* ships `ScrcpyOptions5_0_1`, so you can reach server 5.0.1 **without touching `package.json`** at all. Bump to beta.5 only if you also want its small control-writer bugfixes.
- The only non-trivial code change: in `ScrcpyOptions4_1`/`5_0_1` the `videoCodec` field was re-declared as a **required** property (4_0 left it optional). AYA must add `videoCodec: undefined` (keeps the `h264` default → identical wire output). Verified below.
- The "npm `latest`" tag (`2.3.0`) is a trap: it only supports scrcpy-server **up to 3.3.3**. Do **not** "upgrade" to `latest`.

---

## 1. Compatibility matrix — `@yume-chan/scrcpy` ↔ scrcpy-server

Each `@yume-chan/scrcpy` release bundles one option-builder class per supported scrcpy-server version. The highest bundled class sets the newest server the client can speak to.

| `@yume-chan/scrcpy` | npm dist-tag | Highest bundled options class | Max scrcpy-server | Notes |
|---|---|---|---|---|
| `2.3.0` | **`latest`** | `ScrcpyOptions3_3_3` (`latest.ts`) | **3.3.3 / 3.3.4** | Old 2.x line. Cannot talk to scrcpy-server 4.x or 5.x at all. |
| `3.0.0-beta.4` | (currently pinned in AYA) | `ScrcpyOptions5_0_1` (= alias of `ScrcpyOptions4_1`) | **5.0.1** | Ships `4_0`, `4_1`, `5_0`, `5_0_1` dirs. `latest.ts` → `ScrcpyOptions4_1`. |
| `3.0.0-beta.5` | **`beta`** (newest) | `ScrcpyOptions5_0_1` (= alias of `ScrcpyOptions4_1`) | **5.0.1** | Same version dirs as beta.4; adds control-writer helpers + dep bumps (see §5). |

Evidence: `latest.ts` in each package, and directory listings of each npm tarball.
- `3.0.0-beta.4` `src/latest.ts` → `export { ScrcpyOptions4_1 as ScrcpyOptionsLatest } from "./4_1/index.js";`
- `3.0.0-beta.4` `src/5_0_1.ts` → `export { ScrcpyOptions4_1 as ScrcpyOptions5_0_1 } from "./4_1/index.js";`
- `2.3.0` `src/latest.ts` → `export { ScrcpyOptions3_3_3 as ScrcpyOptionsLatest } from "./3_3_3.js";`

### Server version → client options class

| scrcpy-server | Use this options class | Real implementation? |
|---|---|---|
| `4.0` | `ScrcpyOptions4_0` | **real** (`src/4_0/`) — *AYA's current choice* |
| `4.1` | `ScrcpyOptions4_1` | **real** (`src/4_1/`) |
| `5.0` | `ScrcpyOptions5_0` | alias → `ScrcpyOptions4_1` |
| `5.0.1` | `ScrcpyOptions5_0_1` | alias → `ScrcpyOptions4_1` |

Verified aliases in the installed tree:
```
node_modules/@yume-chan/scrcpy/src/5_0.ts   : export { ScrcpyOptions4_1 as ScrcpyOptions5_0 } from "./4_1/index.js";
node_modules/@yume-chan/scrcpy/src/5_0_1.ts : export { ScrcpyOptions4_1 as ScrcpyOptions5_0_1 } from "./4_1/index.js";
```
(also present in the raw npm tarballs for both beta.4 and beta.5 — so AYA's `node_modules` is not locally patched.)

---

## 2. What AYA currently does (integration map)

| Concern | Location | Value |
|---|---|---|
| Jar download version | `script/scrcpy.mjs:4` | `const version = '4.0'` |
| Jar download URL | `script/scrcpy.mjs:5` | `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}` |
| Jar written to | `script/scrcpy.mjs:8` | `resources/scrcpy.jar` |
| **Server launch version string** | `src/main/lib/adb/scrcpy.ts:23` | `... com.genymobile.scrcpy.Server 4.0 ${args.join(' ')}` |
| Jar pushed to device | `src/main/lib/adb/scrcpy.ts:39-41` | `resolveResources('scrcpy.jar')` → `/data/local/tmp/aya/scrcpy.jar` |
| Client options class (renderer) | `src/renderer/screencast/store.ts:5` (import), `:70` (construct) | `import { ScrcpyOptions4_0 }` ; `new ScrcpyOptions4_0<ScrcpyOptions4_0.Init>({ audio:true, videoBitRate, maxSize, clipboardAutosync:true, stayAwake:true, scid })` |
| Options class type in client | `src/renderer/screencast/lib/ScrcpyClient.ts:6` (import), `:53` (field), `:63` (ctor) | `ScrcpyOptions4_0<ScrcpyOptions4_0.Init>` |
| Args serialized to server | `src/renderer/screencast/lib/ScrcpyClient.ts:185` | `main.startScrcpy(deviceId, options.serialize())` |
| Bundled jar version | `resources/scrcpy.jar` (`classes.dex`) | **v4.0** — contains literal `The server version (4.0) does not match the client (`; `META-INF/version-control-info.textproto` revision `048c747cc10b3a7fe2d313d8ad2ed41d26c90ae7` |

Pinned `@yume-chan/*` deps at `3.0.0-beta.4` (`package.json:48-53`): `media-codec`, `no-data-view`, `pcm-player`, `scrcpy`, `scrcpy-decoder-webcodecs`, `stream-extra`.

> `resources/` is in `.gitignore`, so `resources/scrcpy.jar` is **untracked** — rollback must re-download it (see §7).

The previous version bump (`git show 126c6c5`, "upgrade scrcpy to 4.0") touched exactly the same 3 code files + `package.json`/lock — a reliable template for what a bump must reach: `script/scrcpy.mjs`, `src/main/lib/adb/scrcpy.ts`, `src/renderer/screencast/store.ts`, `src/renderer/screencast/lib/ScrcpyClient.ts`, `package.json`.

---

## 3. What changed in scrcpy-server v4.0 → v5.0.1 (client-protocol impact)

Source: Genymobile/scrcpy GitHub release notes (primary).

### v4.0 → v4.1 (2026-07-12) — **client-visible additions**
Release: https://github.com/Genymobile/scrcpy/releases/tag/v4.1
- Add VP8 and VP9 video encoders (`--video-codec=vp8|vp9`).
- Add `--ignore-video-encoder-constraints`.
- "Trigger media scan after file push" → new **`ScanFile` control message (id 22)** on the control socket.
- Size-constraint / colorspace fixes.

Library mirror: `4_1/impl/init.ts` adds `videoCodec: … | "vp8" | "vp9"` and `ignoreVideoEncoderConstraints?`; `4_1/impl/control-message-types.ts` adds `[ScrcpyControlMessageType.ScanFile]: 22`. This is the only real protocol step in the whole range.

### v4.1 → v5.0 (2026-10-05) — **NO client protocol change**
Release: https://github.com/Genymobile/scrcpy/releases/tag/v5.0
- Headline is **hardware decoding on the computer** (`--hwdec`), plus better video buffering, "capture all audio usages", UHID/keyboard-layout fixes, and toolchain upgrades (FFmpeg 9, SDL 3.4.18, platform-tools 37.0.1).
- These are all **desktop-client / rendering** concerns. `--hwdec` is a local decoder selection, not a server option; no new server socket, no new stream header, no new server arg.
- Library mirror: `5_0.ts` is a pure alias of `4_1` → author confirms unchanged wire protocol.

### v5.0 → v5.0.1 (2026-10-08) — **bugfix only, no protocol change**
Release: https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1
- Hardware-decoding fixes (NV12 chroma, H.265 on Windows, VA-API GPU selection, EGL). No protocol/API surface change.
- Library mirror: `5_0_1.ts` alias of `4_1`.

**Net:** the only breaking-ish step a client must react to is **4.0 → 4.1** (VP8/VP9 + `ScanFile` + `ignore-video-encoder-constraints`). Going **4.1 → 5.0 / 5.0.1 adds nothing the client must implement**, which is exactly why the library aliases those classes.

---

## 4. Why this pairing is safe (tested)

I type-checked and ran AYA's exact option set against both `ScrcpyOptions4_0` and `ScrcpyOptions5_0_1` using the installed `3.0.0-beta.4` (isolated `tsc` + `tsx`, no repo files changed):

```
ScrcpyOptions4_0   serialize() -> ['stay_awake=true', 'scid=123']
ScrcpyOptions5_0_1 serialize() -> ['stay_awake=true', 'scid=123']   // identical, with videoCodec: undefined
ScrcpyOptions5_0_1 serialize() -> ['stay_awake=true', 'scid=123']   // identical, with videoCodec: 'h264'
value.videoCodec   -> 'h264'   (both undefined and 'h264' resolve to the default)
```

Conclusions:
1. **Wire args are byte-identical** between 4_0 and 5_0_1 for AYA's options (`audio`, `videoBitRate`, `maxSize`, `clipboardAutosync` equal their defaults → omitted; `stay_awake`, `scid` emitted). No behavioral change.
2. `serialize()` uses the stable `snake_case=value` scrcpy-server argument format (unchanged since scrcpy 1.21 — see `src/1_21/impl/serialize.ts`), so a 5.0.1 server accepts it.
3. **Only compile-time change needed:** `ScrcpyOptions4_1`/`5_0_1` re-declares `videoCodec` as a *required* property:
   - `src/4_1/impl/init.ts:3-4` → `export interface Init extends Omit<PrevImpl.Init, "videoCodec"> { videoCodec: PrevImpl.Init["videoCodec"] | "vp8" | "vp9"; … }`
   - `PrevImpl.Init["videoCodec"]` is `"h264" | "h265" | "av1" | undefined` (from `src/2_0/impl/init.ts:33`), so `videoCodec: undefined` satisfies it and keeps the default.

All other AYA API usage is present unchanged in `4_1`/`5_0_1` (inherited via `4_1/impl/index.ts` → `export * from "../../4_0/impl/index.js"`):
- `options.value.scid`, `options.serialize()`, `options.parseVideoStreamMetadata()`, `options.parseAudioStreamMetadata()`, `options.createMediaStreamTransformer()`, `options.clipboard`, `options.deviceMessageParsers`
- `new ScrcpyControlMessageWriter(writer, options)` and its methods used by AYA: `injectKeyCode`, `injectText`, `injectTouch`, `injectScroll`, `setClipboard`, `setDisplayPower`, `resetVideo`
- `ScrcpyVideoCodecId` (H264/H265/Av1/Vp8/Vp9), `ScrcpyAudioCodec`, `ScrcpyMediaStreamDataPacket`, `ScrcpyVideoStreamPacket`, `AndroidMotionEventAction/Button`, `AndroidKeyEventAction`, `AndroidKeyCode`.

AYA's "session packet" filter (`ScrcpyClient.ts:268-282`, "Since scrcpy 4.0 … session packets") stays valid because `4_1` reuses `4_0`'s `media-stream-transformer.ts`.

---

## 5. `3.0.0-beta.4` → `3.0.0-beta.5` (if you bump)

Publish dates: beta.4 = 2026-10-09, beta.5 = 2026-11-06. scrcpy-server 5.0.1 released 2026-10-08 — i.e. beta.4's `5_0_1` alias was authored **after** 5.0.1 existed (deliberate, not a guess).

`diff -rq` of the two tarballs: only these source files changed (plus dep bumps):
- `src/control/writer.ts` — adds `injectKeyDown`, `injectKeyUp`, `injectKeyPress(hold=100)` helpers; `suppressUnhandledRejection(result[1])` on clipboard ack. (Additive; AYA doesn't call the new helpers.)
- `src/1_21/impl/set-clipboard.ts` — reject with a real `Error("Control socket closed before acknowledgment")` instead of `reject()`.

All six `@yume-chan` packages have a `3.0.0-beta.5` and use **exact** inter-deps at beta.5, so they must move together:
- `scrcpy` → deps `async ^4.2.2`, `event/struct/no-data-view/stream-extra 3.0.0-beta.5`
- `scrcpy-decoder-webcodecs` → also `scrcpy 3.0.0-beta.5`, `media-codec 3.0.0-beta.5`, `scrcpy-decoder-shared 3.0.0-beta.5`
- `media-codec`, `no-data-view`, `pcm-player`, `stream-extra` all at `3.0.0-beta.5`
- (`@yume-chan/scrcpy-decoder-shared@3.0.0-beta.4` is already installed transitively; npm will pull the beta.5 with the bump.)

Bumping is optional — it does not change scrcpy-server compatibility (both lines top out at 5.0.1).

---

## 6. Concrete upgrade — exact edits

Target: **scrcpy-server `5.0.1` + `ScrcpyOptions5_0_1`**. Pick one dependency variant.

### 6a. Recommended: also bump the `@yume-chan/*` set to `3.0.0-beta.5`
`package.json:48-53` — change all six `3.0.0-beta.4` → `3.0.0-beta.5`, then `npm install` (updates `package-lock.json`).

### 6b. Minimal: keep the pinned `3.0.0-beta.4` (no `package.json` change)
Works as-is because beta.4 already bundles `ScrcpyOptions5_0_1`.

### Code changes (identical for 6a and 6b)

1. **`script/scrcpy.mjs:4`** — `const version = '4.0'` → `const version = '5.0.1'`.

2. **`src/main/lib/adb/scrcpy.ts:23`** — `com.genymobile.scrcpy.Server 4.0` → `com.genymobile.scrcpy.Server 5.0.1`.
   > Must match the jar exactly — the server aborts on mismatch (`"The server version (5.0.1) does not match the client (…)"`).

3. **`src/renderer/screencast/store.ts`**
   - `:5` — `import { ScrcpyOptions4_0 } from '@yume-chan/scrcpy'` → `import { ScrcpyOptions5_0_1 } from '@yume-chan/scrcpy'`
   - `:70` — `new ScrcpyOptions4_0<ScrcpyOptions4_0.Init>({` → `new ScrcpyOptions5_0_1<ScrcpyOptions5_0_1.Init>({`
   - inside the init object (`:71-77`) add `videoCodec: undefined,` (keeps `h264` default; required only for the type).

4. **`src/renderer/screencast/lib/ScrcpyClient.ts`**
   - `:6` import `ScrcpyOptions4_0` → `ScrcpyOptions5_0_1`
   - `:53` `private options: ScrcpyOptions4_0<ScrcpyOptions4_0.Init>` → `ScrcpyOptions5_0_1<ScrcpyOptions5_0_1.Init>`
   - `:63` ctor param `options: ScrcpyOptions4_0<ScrcpyOptions4_0.Init>` → `ScrcpyOptions5_0_1<ScrcpyOptions5_0_1.Init>`

5. **Regenerate the jar** — `npm run scrcpy` (downloads `scrcpy-server-v5.0.1`, 733,930 bytes, into `resources/scrcpy.jar`; current v4.0 jar is 732,226 bytes).

No other files need changes: AYA only consumes stable API (listed in §4), and its video/audio/control handling already accounts for the session-packet format introduced in 4.0.

> Optional alternative: `ScrcpyOptions4_1` is the same implementation and equally correct with server 5.0.1 (same `videoCodec`-required change). `ScrcpyOptions5_0_1` is preferred as it names the exact server version.

---

## 7. Verify & roll back

**Verify**
1. `npm run build` (or `npx tsc --noEmit -p tsconfig.json`) — confirms the `videoCodec` type requirement is satisfied.
2. Run AYA against a device; confirm: screen mirrors, audio plays, touch/keyboard input works, clipboard sync works, recording produces a playable `.mkv`.
3. If it fails to start, read the pushed server's stderr (logged at `src/main/lib/adb/scrcpy.ts:27-32`) — a version string that doesn't match the jar prints `The server version (…) does not match the client (…)`.

**Rollback** (all cheap; `resources/` is gitignored so the jar must be re-fetched)
1. Revert the 3 version/type edits (`script/scrcpy.mjs:4`, `src/main/lib/adb/scrcpy.ts:23`, `store.ts`/`ScrcpyClient.ts` class refs; drop `videoCodec` line).
2. `npm run scrcpy` with `'4.0'` restored → re-downloads `scrcpy-server-v4.0` (verified still HTTP 200). Or restore a saved copy of the old jar.
3. If you took 6a, revert `package.json:48-53` to `3.0.0-beta.4` and `npm install`.

Keep a backup of the current `resources/scrcpy.jar` before step 5 if you want an instant rollback without a network fetch.

---

## 8. Claim ↔ source index

| Claim | Primary source |
|---|---|
| dist-tags latest=`2.3.0`, beta=`3.0.0-beta.5`; full version list | `https://registry.npmjs.org/@yume-chan%2Fscrcpy` |
| beta.4/beta.5 ship `5_0_1.ts` alias + `latest.ts`→`4_1` | npm tarballs `https://registry.npmjs.org/@yume-chan/scrcpy/-/scrcpy-3.0.0-beta.4.tgz` and `…-3.0.0-beta.5.tgz` (paths `package/src/5_0_1.ts`, `package/src/latest.ts`) |
| `2.3.0` tops out at `ScrcpyOptions3_3_3` | `https://registry.npmjs.org/@yume-chan/scrcpy/-/scrcpy-2.3.0.tgz` → `package/src/latest.ts` |
| Publish timestamps | `https://registry.npmjs.org/@yume-chan%2Fscrcpy` `time` field |
| Six `@yume-chan` packages all have beta.5 + exact inter-deps | per-package `https://registry.npmjs.org/@yume-chan%2F<name>` `versions['3.0.0-beta.5'].dependencies` |
| scrcpy-server v4.0 changes (SDL3, flex display, session metadata, camera torch/zoom, keep-active) | `https://github.com/Genymobile/scrcpy/releases/tag/v4.0` |
| v4.1 adds VP8/VP9, `--ignore-video-encoder-constraints`, media-scan-after-push | `https://github.com/Genymobile/scrcpy/releases/tag/v4.1` |
| v5.0 = hardware decoding + buffering (client-side) | `https://github.com/Genymobile/scrcpy/releases/tag/v5.0` |
| v5.0.1 = HW-decode bugfixes only | `https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1` |
| v5.0.1 asset `scrcpy-server-v5.0.1` (733,930 B) exists; URL → HTTP 200 | `https://api.github.com/repos/Genymobile/scrcpy/releases/tags/v5.0.1` |
| Bundled jar is v4.0 | `resources/scrcpy.jar` → `classes.dex` string `The server version (4.0) does not match the client (`; rev `048c747cc10b3a7fe2d313d8ad2ed41d26c90ae7` |
| Client yume-chan repo | `https://github.com/yume-chan/ya-webadb` |
