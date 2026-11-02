const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const bundlePath = path.resolve(__dirname, '../build/src/player-control-renderer.bundle.js')
const bundle = fs.readFileSync(bundlePath, 'utf8')
let readyListener

assert.doesNotThrow(() => vm.runInNewContext(bundle, {
  window: { karaokePlayer: {} },
  document: {
    addEventListener(eventName, listener) {
      if (eventName === 'DOMContentLoaded') readyListener = listener
    }
  }
}), 'O bundle do painel precisa resolver seus módulos sem acesso a require do Node no Renderer.')

assert.equal(typeof readyListener, 'function', 'O Renderer precisa registrar o bootstrap da interface.')
process.stdout.write('PASS Player control Renderer bundle: dependências CommonJS incluídas e bootstrap registrado sem Node integration.\n')
