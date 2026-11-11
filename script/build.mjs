const pkg = await fs.readJson('package.json')
const electron = pkg.devDependencies.electron
delete pkg.devDependencies
pkg.devDependencies = {
  electron,
}
delete pkg.scripts
pkg.scripts = {
  start: 'electron main/index.js',
}
pkg.main = 'main/index.js'

await $`npm run build:main`
await $`npm run build:preload`
await $`npm run build:renderer`

// aya.dex is a gradle artifact (resources/ is gitignored); compile it if absent,
// otherwise the packaged app ships without the on-device server and pages hang.
if (!(await fs.pathExists('resources/aya.dex'))) {
  await $`npm run server`
}

await fs.copy('build', 'dist/build')
await fs.copy('resources', 'dist/resources')
cd('dist')

await fs.writeJson('package.json', pkg, {
  spaces: 2,
})

await $`npm i --production`
