import fs from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
const rendererOutput = path.resolve(__dirname, '../src')

fs.mkdirSync(rendererOutput, { recursive: true })
fs.copyFileSync(path.join(projectRoot, 'src', 'index.html'), path.join(rendererOutput, 'index.html'))
fs.copyFileSync(path.join(projectRoot, 'src', 'style.css'), path.join(rendererOutput, 'style.css'))
