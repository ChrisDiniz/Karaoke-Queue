'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const OUTPUT_DIRECTORY = path.resolve(__dirname, '../build-resources/identity')
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
const SUPERSAMPLE = 4
const BASE_SIZE = 256
const HIGH_SIZE = BASE_SIZE * SUPERSAMPLE
const BACKGROUND = [32, 32, 39, 255]
const BORDER = [48, 48, 58, 255]
const GLYPH = [176, 177, 255, 255]

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, checksum])
}

function encodePng(size, pixels) {
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1)
    rows[rowOffset] = 0
    pixels.copy(rows, rowOffset + 1, y * size * 4, (y + 1) * size * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function paint(pixels, x, y, color) {
  const offset = (y * HIGH_SIZE + x) * 4
  const alpha = color[3] / 255
  const oldAlpha = pixels[offset + 3] / 255
  const outAlpha = alpha + oldAlpha * (1 - alpha)
  if (!outAlpha) return
  for (let channel = 0; channel < 3; channel++) {
    pixels[offset + channel] = Math.round((color[channel] * alpha + pixels[offset + channel] * oldAlpha * (1 - alpha)) / outAlpha)
  }
  pixels[offset + 3] = Math.round(outAlpha * 255)
}

function roundedRectangle(pixels, left, top, right, bottom, radius, color) {
  const x0 = Math.round(left * SUPERSAMPLE)
  const y0 = Math.round(top * SUPERSAMPLE)
  const x1 = Math.round(right * SUPERSAMPLE)
  const y1 = Math.round(bottom * SUPERSAMPLE)
  const r = radius * SUPERSAMPLE
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = Math.max(x0 + r, Math.min(x, x1 - r))
      const cy = Math.max(y0 + r, Math.min(y, y1 - r))
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) paint(pixels, x, y, color)
    }
  }
}

function strokeLine(pixels, start, end, width, color) {
  const sx = start[0] * SUPERSAMPLE
  const sy = start[1] * SUPERSAMPLE
  const ex = end[0] * SUPERSAMPLE
  const ey = end[1] * SUPERSAMPLE
  const radius = width * SUPERSAMPLE / 2
  const minX = Math.max(0, Math.floor(Math.min(sx, ex) - radius - 1))
  const maxX = Math.min(HIGH_SIZE - 1, Math.ceil(Math.max(sx, ex) + radius + 1))
  const minY = Math.max(0, Math.floor(Math.min(sy, ey) - radius - 1))
  const maxY = Math.min(HIGH_SIZE - 1, Math.ceil(Math.max(sy, ey) + radius + 1))
  const vx = ex - sx
  const vy = ey - sy
  const lengthSquared = vx * vx + vy * vy
  const radiusSquared = radius * radius
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - sx) * vx + (y - sy) * vy) / lengthSquared))
      const dx = x - (sx + projection * vx)
      const dy = y - (sy + projection * vy)
      if (dx * dx + dy * dy <= radiusSquared) paint(pixels, x, y, color)
    }
  }
}

function strokePolyline(pixels, points, width, color, close = false) {
  for (let index = 1; index < points.length; index++) strokeLine(pixels, points[index - 1], points[index], width, color)
  if (close && points.length > 2) strokeLine(pixels, points[points.length - 1], points[0], width, color)
}

function scalePoints(points) {
  const scale = 7.5
  const offset = 38
  return points.map(([x, y]) => [offset + x * scale, offset + y * scale])
}

function drawRoleIcon(mode) {
  const pixels = Buffer.alloc(HIGH_SIZE * HIGH_SIZE * 4)
  roundedRectangle(pixels, 14, 14, 242, 242, 45, BACKGROUND)
  const borderPath = []
  for (let angle = 180; angle <= 270; angle += 10) borderPath.push([59 + 45 * Math.cos(angle * Math.PI / 180), 59 + 45 * Math.sin(angle * Math.PI / 180)])
  for (let angle = 270; angle <= 360; angle += 10) borderPath.push([197 + 45 * Math.cos(angle * Math.PI / 180), 59 + 45 * Math.sin(angle * Math.PI / 180)])
  for (let angle = 0; angle <= 90; angle += 10) borderPath.push([197 + 45 * Math.cos(angle * Math.PI / 180), 197 + 45 * Math.sin(angle * Math.PI / 180)])
  for (let angle = 90; angle <= 180; angle += 10) borderPath.push([59 + 45 * Math.cos(angle * Math.PI / 180), 197 + 45 * Math.sin(angle * Math.PI / 180)])
  strokePolyline(pixels, borderPath, 3, BORDER, true)

  const paths = mode === 'player'
    ? [
        { points: [[3, 4], [21, 4], [21, 17], [3, 17]], close: true },
        { points: [[8, 21], [16, 21], [12, 21], [12, 17]] },
        { points: [[10, 9], [15, 12], [10, 15], [10, 9]] }
      ]
    : [
        { points: [[2.5, 4], [21.5, 4], [21.5, 19], [2.5, 19]], close: true },
        { points: [[5.5, 8], [10.5, 8]] },
        { points: [[5.5, 11], [10.5, 11]] },
        { points: [[15, 8], [19, 10.5], [15, 13], [15, 8]] },
        { points: [[8, 22], [16, 22], [12, 22], [12, 19]] }
      ]
  for (const stroke of paths) strokePolyline(pixels, scalePoints(stroke.points), 13, GLYPH, stroke.close)

  const base = downsample(pixels, HIGH_SIZE, BASE_SIZE)
  return new Map(ICON_SIZES.map(size => [size, encodePng(size, size === BASE_SIZE ? base : downsample(base, BASE_SIZE, size))]))
}

function downsample(source, sourceSize, targetSize) {
  const pixelsPerAxis = sourceSize / targetSize
  const pixelsPerBlock = pixelsPerAxis * pixelsPerAxis
  const result = Buffer.alloc(targetSize * targetSize * 4)
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let dy = 0; dy < pixelsPerAxis; dy++) {
        for (let dx = 0; dx < pixelsPerAxis; dx++) {
          const offset = (((y * pixelsPerAxis + dy) * sourceSize) + (x * pixelsPerAxis + dx)) * 4
          const pixelAlpha = source[offset + 3] / 255
          red += source[offset] * pixelAlpha
          green += source[offset + 1] * pixelAlpha
          blue += source[offset + 2] * pixelAlpha
          alpha += pixelAlpha
        }
      }
      const outputOffset = (y * targetSize + x) * 4
      const averageAlpha = alpha / pixelsPerBlock
      if (alpha) {
        result[outputOffset] = Math.round(red / alpha)
        result[outputOffset + 1] = Math.round(green / alpha)
        result[outputOffset + 2] = Math.round(blue / alpha)
      }
      result[outputOffset + 3] = Math.round(averageAlpha * 255)
    }
  }
  return result
}

function encodeIco(images) {
  const entries = [...images.entries()]
  const header = Buffer.alloc(6 + entries.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const payloads = []
  let offset = header.length
  entries.forEach(([size, payload], index) => {
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header[entry + 2] = 0
    header[entry + 3] = 0
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(payload.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    payloads.push(payload)
    offset += payload.length
  })
  return Buffer.concat([header, ...payloads])
}

function buildFunctionIcons(outputDirectory = OUTPUT_DIRECTORY) {
  fs.mkdirSync(outputDirectory, { recursive: true })
  const target = outputDirectory
  const images = [
    ['player', 'karaoke-player'],
    ['combined', 'karaoke-combined']
  ]
  for (const [mode, baseName] of images) {
    const iconImages = drawRoleIcon(mode)
    fs.writeFileSync(path.join(target, `${baseName}.png`), iconImages.get(256))
    fs.writeFileSync(path.join(target, `${baseName}.ico`), encodeIco(iconImages))
  }
  return images.map(([, baseName]) => ({
    png: path.join(target, `${baseName}.png`), ico: path.join(target, `${baseName}.ico`)
  }))
}

if (require.main === module) buildFunctionIcons()

module.exports = { buildFunctionIcons, encodeIco }
