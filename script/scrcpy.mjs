import path from 'path'
import normalizePath from 'licia/normalizePath.js'

const version = '5.0.1'
const url = `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}`

const scrcpyDir = normalizePath(path.resolve(__dirname, '../resources'))
await $`curl -Lk ${url} > ${scrcpyDir}/scrcpy.jar`
await fs.writeFile(`${scrcpyDir}/scrcpy.version`, version)
