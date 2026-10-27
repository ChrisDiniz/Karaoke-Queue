import fs from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
const rendererOutput = path.resolve(__dirname, '../src')

fs.mkdirSync(rendererOutput, { recursive: true })
fs.copyFileSync(path.join(projectRoot, 'src', 'index.html'), path.join(rendererOutput, 'index.html'))
fs.copyFileSync(path.join(projectRoot, 'src', 'style.css'), path.join(rendererOutput, 'style.css'))
fs.cpSync(path.join(projectRoot, 'src', 'assets'), path.join(rendererOutput, 'assets'), { recursive: true })

// The renderer loads app.js as a classic script (index.html is intentionally
// unchanged). Bundle its small CommonJS rule modules into that script without
// exposing Node APIs in the isolated renderer.
const moduleNames = [
  'queue-rules', 'debut-cadence-rules', 'round-robin-rules', 'fixed-turn-rules', 'frozen-queue-rules', 'history-rules', 'singer-suggestions', 'state-repository', 'licensing', 'application',
  'ui/dom', 'ui/queue-view', 'ui/history-view', 'ui/queue-interactions',
  'ui/table-dialog', 'ui/app-shell', 'ui/navigation', 'ui/sidebar-display-name', 'ui/settings-view', 'ui/previous-sessions-view', 'app'
]
const factories = moduleNames.map(name => {
  const source = fs.readFileSync(path.join(rendererOutput, `${name}.js`), 'utf8')
  return `"./${name}": function(module, exports, require) {\n${source}\n}`
}).join(',\n')
const bundle = `(function() {\n  const factories = {\n${factories}\n  };\n  const cache = {};\n  function resolve(parent, request) {\n    const parts = (parent ? parent.split('/').slice(0, -1) : []).concat(request.split('/'));\n    const resolved = [];\n    for (const part of parts) { if (!part || part === '.') continue; if (part === '..') resolved.pop(); else resolved.push(part); }\n    return './' + resolved.join('/');\n  }\n  function require(id, parent) {\n    const key = resolve(parent, id);\n    if (cache[key]) return cache[key].exports;\n    if (!factories[key]) throw new Error('Unknown renderer module: ' + key);\n    const module = { exports: {} };\n    cache[key] = module;\n    factories[key](module, module.exports, request => require(request, key));\n    return module.exports;\n  }\n  require('./app', '');\n})();\n`
fs.writeFileSync(path.join(rendererOutput, 'app.js'), bundle)
