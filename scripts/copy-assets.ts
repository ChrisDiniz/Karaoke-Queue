import fs from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
const rendererOutput = path.resolve(__dirname, '../src')

function bundleCommonJsModules(moduleNames: readonly string[], entryModule: string): string {
  const factories = moduleNames.map(name => {
    const source = fs.readFileSync(path.join(rendererOutput, `${name}.js`), 'utf8')
    return `"./${name}": function(module, exports, require) {\n${source}\n}`
  }).join(',\n')
  return `(function() {\n  const factories = {\n${factories}\n  };\n  const cache = {};\n  function resolve(parent, request) {\n    const parts = (parent ? parent.split('/').slice(0, -1) : []).concat(request.split('/'));\n    const resolved = [];\n    for (const part of parts) { if (!part || part === '.') continue; if (part === '..') resolved.pop(); else resolved.push(part); }\n    return './' + resolved.join('/');\n  }\n  function require(id, parent) {\n    const key = resolve(parent, id);\n    if (cache[key]) return cache[key].exports;\n    if (!factories[key]) throw new Error('Unknown renderer module: ' + key);\n    const module = { exports: {} };\n    cache[key] = module;\n    factories[key](module, module.exports, request => require(request, key));\n    return module.exports;\n  }\n  require('${entryModule}', '');\n})();\n`
}

fs.mkdirSync(rendererOutput, { recursive: true })
fs.copyFileSync(path.join(projectRoot, 'src', 'index.html'), path.join(rendererOutput, 'index.html'))
fs.copyFileSync(path.join(projectRoot, 'src', 'style.css'), path.join(rendererOutput, 'style.css'))
fs.copyFileSync(path.join(projectRoot, 'src', 'player-playback.html'), path.join(rendererOutput, 'player-playback.html'))
fs.copyFileSync(path.join(projectRoot, 'src', 'player-playback.css'), path.join(rendererOutput, 'player-playback.css'))
fs.copyFileSync(path.join(projectRoot, 'src', 'player-control.html'), path.join(rendererOutput, 'player-control.html'))
fs.copyFileSync(path.join(projectRoot, 'src', 'player-control.css'), path.join(rendererOutput, 'player-control.css'))
fs.copyFileSync(path.join(projectRoot, 'src', 'welcome.html'), path.join(rendererOutput, 'welcome.html'))
fs.copyFileSync(path.join(projectRoot, 'src', 'welcome.css'), path.join(rendererOutput, 'welcome.css'))
fs.copyFileSync(path.join(projectRoot, 'src', 'standalone-player.html'), path.join(rendererOutput, 'standalone-player.html'))
fs.copyFileSync(path.join(projectRoot, 'src', 'standalone-player.css'), path.join(rendererOutput, 'standalone-player.css'))
fs.cpSync(path.join(projectRoot, 'src', 'assets'), path.join(rendererOutput, 'assets'), { recursive: true })

// Keep the privileged media Renderer separate from the Controller UI bundle.
const playbackRendererSource = fs.readFileSync(path.join(rendererOutput, 'player-playback-renderer.js'), 'utf8')
fs.writeFileSync(path.join(rendererOutput, 'player-playback.js'),
  `(function() {\n  const module = { exports: {} };\n  const exports = module.exports;\n${playbackRendererSource}\n})();\n`)

fs.writeFileSync(path.join(rendererOutput, 'player-control-renderer.bundle.js'),
  bundleCommonJsModules(['player-ui-contracts', 'player-control-renderer'], './player-control-renderer'))

const welcomeRendererSource = fs.readFileSync(path.join(rendererOutput, 'welcome-renderer.js'), 'utf8')
fs.writeFileSync(path.join(rendererOutput, 'welcome-renderer.bundle.js'),
  `(function() {\n  const module = { exports: {} };\n  const exports = module.exports;\n${welcomeRendererSource}\n})();\n`)

fs.writeFileSync(path.join(rendererOutput, 'standalone-player-renderer.bundle.js'),
  bundleCommonJsModules([
    'standalone-player-keyboard',
    'standalone-player-interaction',
    'standalone-player-interaction-transport',
    'standalone-player-metadata-preview',
    'standalone-player-renderer'
  ], './standalone-player-renderer'))

// The isolated Standalone harness combines the existing restricted bridges
// with the small contracts module used to validate celebration messages.
// Bundle local CommonJS modules so the sandboxed preload only requires Electron itself.
const preloadFactories = ['player-preload', 'standalone-player-preload', 'src/standalone-player-contracts'].map(name => {
  const source = fs.readFileSync(path.join(projectRoot, 'build', `${name}.js`), 'utf8')
  return `"./${name}": function(module, exports, require) {\n${source}\n}`
}).join(',\n')
fs.writeFileSync(path.join(projectRoot, 'build', 'standalone-player-ui-preload.js'),
  `(function(externalRequire) {\n  const factories = {\n${preloadFactories}\n  };\n  const cache = {};\n  function resolve(parent, request) {\n    const parts = (parent ? parent.split('/').slice(0, -1) : []).concat(request.split('/'));\n    const resolved = [];\n    for (const part of parts) { if (!part || part === '.') continue; if (part === '..') resolved.pop(); else resolved.push(part); }\n    return './' + resolved.join('/');\n  }\n  function require(id, parent) {\n    const key = resolve(parent, id);\n    if (cache[key]) return cache[key].exports;\n    if (!factories[key]) return externalRequire(id);\n    const module = { exports: {} };\n    cache[key] = module;\n    factories[key](module, module.exports, request => require(request, key));\n    return module.exports;\n  }\n  require('./player-preload', '');\n  require('./standalone-player-preload', '');\n})(require);\n`)

// The renderer loads app.js as a classic script (index.html is intentionally
// unchanged). Bundle its small CommonJS rule modules into that script without
// exposing Node APIs in the isolated renderer.
const moduleNames = [
  'queue-rules', 'debut-cadence-rules', 'round-robin-rules', 'fixed-turn-rules', 'frozen-queue-rules', 'history-rules', 'singer-suggestions', 'state-repository', 'licensing', 'application',
  'ui/dom', 'ui/queue-view', 'ui/history-view', 'ui/queue-interactions',
  'ui/table-dialog', 'ui/app-shell', 'ui/navigation', 'ui/sidebar-display-name', 'ui/settings-view', 'ui/previous-sessions-view', 'app'
]
fs.writeFileSync(path.join(rendererOutput, 'app.js'), bundleCommonJsModules(moduleNames, './app'))
