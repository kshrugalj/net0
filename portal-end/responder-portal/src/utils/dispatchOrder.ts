import type { Incident } from '../types/incident'
import { getPrimaryResponse } from './primaryResponse'

export function dispatchCode(orderNumber: number): string {
  return String(orderNumber).padStart(3, '0')
}

export function severityLabel(priority: number | null): string {
  if (priority == null) return 'PENDING'
  if (priority >= 5) return 'CRITICAL'
  if (priority >= 4) return 'HIGH'
  if (priority >= 3) return 'MEDIUM'
  return 'LOW'
}

function coordinatesOf(incident: Incident): [number, number] | null {
  if (
    incident.lat != null &&
    incident.lon != null &&
    Number.isFinite(incident.lat) &&
    Number.isFinite(incident.lon)
  ) {
    return [incident.lat, incident.lon]
  }
  return null
}

function formatCoordinates(incident: Incident): string {
  const point = coordinatesOf(incident)
  if (!point) return 'GPS not reported'
  const base = `${point[0].toFixed(5)}, ${point[1].toFixed(5)}`
  return incident.gpsAccuracy == null ? base : `${base} (±${incident.gpsAccuracy} m)`
}

function milesBetween(left: [number, number], right: [number, number]): number {
  const toRad = (value: number) => (value * Math.PI) / 180
  const dLat = toRad(right[0] - left[0])
  const dLon = toRad(right[1] - left[1])
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(left[0])) * Math.cos(toRad(right[0])) * Math.sin(dLon / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function operatingMiles(incidents: Incident[]): number | null {
  const points = incidents.flatMap(incident => {
    const point = coordinatesOf(incident)
    return point ? [point] : []
  })
  if (points.length < 2) return null
  let span = 0
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      span = Math.max(span, milesBetween(points[i], points[j]))
    }
  }
  return span
}

function recommended(incident: Incident): string {
  if (incident.aiResponders.length) {
    return incident.aiResponders.map(responder => getPrimaryResponse(responderLabel(responder))).join(', ')
  }
  return getPrimaryResponse(incident.type)
}

function responderLabel(responder: string): string {
  if (responder === 'medical_ems') return 'medical'
  if (responder === 'fire_rescue') return 'fire'
  if (responder === 'law_enforcement') return 'security'
  if (responder === 'technical_sar') return 'trapped'
  if (responder === 'humanitarian_care') return 'other'
  if (responder === 'coast_guard') return 'flood'
  return responder
}

function uniqueResources(incidents: Incident[]): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const incident of incidents) {
    for (const item of recommended(incident).split(', ')) {
      if (!item || seen.has(item)) continue
      seen.add(item)
      list.push(item)
    }
  }
  return list
}

export function responseOverview(incidents: Incident[]): string {
  if (!incidents.length) return ''
  const primary = [...incidents].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]
  const span = operatingMiles(incidents)
  const area = span == null ? '' : ` within ${span < 0.1 ? '0.1' : span.toFixed(1)} mi`
  const count = `${incidents.length} incident${incidents.length === 1 ? '' : 's'}`
  const where = primary.placeName || primary.location
  const place = where ? ` near ${where}` : ''
  return `${count}${area}. Primary concern is ${primary.type.toLowerCase()}${place}.`
}

function severityEmoji(priority: number | null): string {
  if (priority == null) return '⚪'
  if (priority >= 5) return '🔴'
  if (priority >= 4) return '🟠'
  if (priority >= 3) return '🟡'
  return '🟢'
}

function typeEmoji(type: string): string {
  switch (type.trim().toLowerCase()) {
    case 'medical':
      return '🚑'
    case 'fire':
      return '🔥'
    case 'trapped':
      return '🆘'
    case 'flood':
      return '🌊'
    case 'structural':
      return '🏚️'
    case 'security':
      return '🚓'
    case 'hazmat':
      return '☣️'
    default:
      return '📍'
  }
}

function resourceEmoji(label: string): string {
  const key = label.toLowerCase()
  if (key.includes('ems') || key.includes('medical')) return '🚑'
  if (key.includes('fire')) return '🔥'
  if (key.includes('law')) return '🚓'
  if (key.includes('hazmat')) return '☣️'
  if (key.includes('rescue')) return '🆘'
  return '🧰'
}

interface DispatchStop {
  index: number
  severity: string
  severityMark: string
  type: string
  typeMark: string
  place: string
  gps: string
  people: string
  needs: string
  response: string
  summary: string
}

function highestPriority(incidents: Incident[]): number | null {
  return incidents.reduce<number | null>((max, incident) => {
    if (incident.priority == null) return max
    return max == null || incident.priority > max ? incident.priority : max
  }, null)
}

function dispatchStops(incidents: Incident[]): DispatchStop[] {
  return incidents.map((incident, index) => {
    const response = recommended(incident)
    return {
      index: index + 1,
      severity: severityLabel(incident.priority),
      severityMark: severityEmoji(incident.priority),
      type: incident.type,
      typeMark: typeEmoji(incident.type),
      place: incident.placeName || incident.location || 'Location not provided',
      gps: formatCoordinates(incident),
      people:
        incident.people > 0
          ? `${incident.people} ${incident.people === 1 ? 'person' : 'people'}`
          : 'Not reported',
      needs: incident.needs?.length ? incident.needs.join(', ') : '',
      response,
      summary: incident.aiSummary?.trim() ?? '',
    }
  })
}

function wrap(text: string, width = 88): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  if (!words[0]) return []
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > width && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

function field(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`
}

export function dispatchText(orderNumber: number, incidents: Incident[]): string {
  const code = dispatchCode(orderNumber)
  const resources = uniqueResources(incidents)
  const highest = highestPriority(incidents)
  const lines = [
    `NET0 DISPATCH  #${code}`,
    new Date().toLocaleString(),
    '',
    ...wrap(responseOverview(incidents)),
    '',
    field('Stops', String(incidents.length)),
    field('Highest', severityLabel(highest)),
    field('Recommended', resources.length ? resources.join(', ') : 'Dispatcher review'),
    '',
  ]
  for (const stop of dispatchStops(incidents)) {
    lines.push(`Stop ${stop.index}`)
    lines.push(field('Priority', stop.severity))
    lines.push(field('Type', stop.type))
    lines.push(field('Location', stop.place))
    lines.push(field('GPS', stop.gps))
    lines.push(field('People', stop.people))
    if (stop.needs) lines.push(field('Needs', stop.needs))
    lines.push(field('Response', stop.response))
    if (stop.summary) {
      wrap(stop.summary, 68).forEach((line, lineIndex) => {
        lines.push(lineIndex === 0 ? field('Summary', line) : `              ${line}`)
      })
    }
    lines.push('')
  }
  lines.push('Full report context is in NET0.')
  return lines.join('\n')
}

function pdfSafe(value: string): string {
  return value
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/±/g, '+/-')
    .replace(/[^\x20-\x7E]/g, '')
}

function pdfEscape(value: string): string {
  return pdfSafe(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function estimateWidth(text: string, size: number): number {
  let units = 0
  for (const char of text) {
    if (char === ' ') units += 0.33
    else if ('iIlj.,:;\'|'.includes(char)) units += 0.28
    else if ('mwMW@'.includes(char)) units += 0.78
    else if (char >= '0' && char <= '9') units += 0.56
    else units += 0.52
  }
  return units * size
}

function wrapToWidth(text: string, maxWidth: number, size: number): string[] {
  const words = pdfSafe(text).replace(/\s+/g, ' ').trim().split(' ')
  if (!words[0]) return []
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (estimateWidth(next, size) > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

const emojiJpegCache = new Map<string, Uint8Array>()

function renderEmojiJpeg(emoji: string, background: string): Uint8Array | null {
  if (typeof document === 'undefined') return null
  const key = `${emoji}|${background}`
  const cached = emojiJpegCache.get(key)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  const size = 64
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = background
  context.fillRect(0, 0, size, size)
  context.font = '46px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(emoji, size / 2, size / 2 + 1)
  const payload = canvas.toDataURL('image/jpeg', 0.92).split(',')[1]
  if (!payload) return null
  const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0))
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  emojiJpegCache.set(key, bytes)
  return bytes
}

const PAGE_W = 612
const PAGE_H = 792
const LEFT = 36
const RIGHT = 576
const TABLE_W = RIGHT - LEFT
const BOTTOM = 48

const STOP_COLUMNS = [
  { title: '#', width: 28 },
  { title: 'Priority', width: 84 },
  { title: 'Type', width: 80 },
  { title: 'Location', width: 120 },
  { title: 'GPS', width: 100 },
  { title: 'People', width: 42 },
  { title: 'Response', width: 86 },
]

function num(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

interface PdfPage {
  commands: string[]
  images: Set<string>
}

interface EmojiImage {
  name: string
  jpeg: Uint8Array
}

export function renderDispatchPdf(orderNumber: number, incidents: Incident[]): Uint8Array {
  const code = dispatchCode(orderNumber)
  const stops = dispatchStops(incidents)
  const resources = uniqueResources(incidents)
  const highest = highestPriority(incidents)
  const images: EmojiImage[] = []
  const pages: PdfPage[] = []
  let page: PdfPage = { commands: [], images: new Set() }
  let y = PAGE_H - 40

  function emojiName(emoji: string, background: string): string | null {
    const jpeg = renderEmojiJpeg(emoji, background)
    if (!jpeg) return null
    const existing = images.find(item => item.jpeg === jpeg)
    if (existing) return existing.name
    const name = `E${images.length + 1}`
    images.push({ name, jpeg })
    return name
  }

  function useEmoji(emoji: string, background: string): string | null {
    const name = emojiName(emoji, background)
    if (name) page.images.add(name)
    return name
  }

  function startPage(continued: boolean) {
    page = { commands: [], images: new Set() }
    pages.push(page)
    page.commands.push('0.6 w')
    y = PAGE_H - 42
    if (!continued) return
    text(LEFT, y - 11, `NET0 DISPATCH #${code}   continued`, 11, true, [0.08, 0.14, 0.11])
    y -= 24
    drawStopHeader()
  }

  function text(
    x: number,
    baseline: number,
    value: string,
    size: number,
    bold: boolean,
    color: [number, number, number],
  ) {
    page.commands.push(`${color[0]} ${color[1]} ${color[2]} rg`)
    page.commands.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${num(x)} ${num(baseline)} Tm (${pdfEscape(value)}) Tj ET`,
    )
  }

  function fillRect(x: number, bottom: number, w: number, h: number, color: [number, number, number]) {
    page.commands.push(`${color[0]} ${color[1]} ${color[2]} rg`)
    page.commands.push(`${num(x)} ${num(bottom)} ${num(w)} ${num(h)} re f`)
  }

  function strokeRect(x: number, bottom: number, w: number, h: number, color: [number, number, number]) {
    page.commands.push(`${color[0]} ${color[1]} ${color[2]} RG`)
    page.commands.push(`${num(x)} ${num(bottom)} ${num(w)} ${num(h)} re S`)
  }

  function imageAt(name: string, x: number, bottom: number, size: number) {
    page.commands.push(`q ${num(size)} 0 0 ${num(size)} ${num(x)} ${num(bottom)} cm /${name} Do Q`)
  }

  function drawStopHeader() {
    const height = 18
    const bottom = y - height
    fillRect(LEFT, bottom, TABLE_W, height, [0.89, 0.95, 0.91])
    strokeRect(LEFT, bottom, TABLE_W, height, [0.72, 0.82, 0.76])
    let x = LEFT
    for (const column of STOP_COLUMNS) {
      text(x + 5, bottom + 5, column.title, 8, true, [0.1, 0.18, 0.14])
      x += column.width
    }
    let lineX = LEFT
    page.commands.push('0.72 0.82 0.76 RG')
    for (let index = 0; index < STOP_COLUMNS.length - 1; index += 1) {
      lineX += STOP_COLUMNS[index].width
      page.commands.push(`${num(lineX)} ${num(bottom)} m ${num(lineX)} ${num(bottom + height)} l S`)
    }
    y = bottom
  }

  startPage(false)
  text(LEFT, y - 16, `NET0 DISPATCH  #${code}`, 18, true, [0.07, 0.12, 0.1])
  y -= 28
  text(LEFT, y - 9, new Date().toLocaleString(), 9, false, [0.35, 0.42, 0.38])
  y -= 16
  page.commands.push('0.45 0.72 0.55 RG 1.4 w')
  page.commands.push(`${LEFT} ${num(y)} m ${RIGHT} ${num(y)} l S`)
  page.commands.push('0.6 w')
  y -= 16

  for (const line of wrapToWidth(responseOverview(incidents), TABLE_W, 10)) {
    text(LEFT, y - 10, line, 10, false, [0.12, 0.16, 0.14])
    y -= 14
  }
  y -= 8

  const factLabels = ['STOPS', 'HIGHEST', 'RECOMMENDED']
  const factValues = [
    String(incidents.length),
    `${severityLabel(highest)}`,
    resources.length ? resources.join(', ') : 'Dispatcher review',
  ]
  const factMarks = ['📋', severityEmoji(highest), resources.length ? resourceEmoji(resources[0]) : '🧰']
  const factWidth = TABLE_W / 3
  const factValueLines = factValues.map((value, index) =>
    wrapToWidth(value, factWidth - (index === 0 ? 16 : 32), 10),
  )
  const factHeight = 34 + Math.max(...factValueLines.map(lines => lines.length)) * 12
  const factBottom = y - factHeight
  factValues.forEach((_, index) => {
    const x = LEFT + index * factWidth
    fillRect(x, factBottom, factWidth, factHeight, [0.95, 0.98, 0.96])
    strokeRect(x, factBottom, factWidth, factHeight, [0.72, 0.82, 0.76])
    text(x + 8, factBottom + factHeight - 16, factLabels[index], 8, true, [0.28, 0.4, 0.34])
    const mark = useEmoji(factMarks[index], '#f2faf5')
    if (mark) imageAt(mark, x + 8, factBottom + factHeight - 40, 12)
    factValueLines[index].forEach((line, lineIndex) => {
      text(x + (mark ? 24 : 8), factBottom + factHeight - 36 - lineIndex * 12, line, 10, true, [0.08, 0.14, 0.11])
    })
  })
  y = factBottom - 18

  text(LEFT, y - 10, 'Stops', 11, true, [0.08, 0.14, 0.11])
  y -= 18
  drawStopHeader()

  const ink: [number, number, number] = [0.1, 0.14, 0.13]
  const rule: [number, number, number] = [0.78, 0.84, 0.8]

  for (const stop of stops) {
    const people = stop.people === 'Not reported' ? '-' : stop.people.replace(' people', '').replace(' person', '')
    const gpsMatch = stop.gps.match(/\(([^)]+)\)/)
    const presets = [
      [String(stop.index)],
      [stop.severity],
      [stop.type],
      [stop.place],
      [stop.gps.replace(/\s*\([^)]*\)/, ''), ...(gpsMatch ? [`(${gpsMatch[1]})`] : [])],
      [people],
      stop.response.split(', ').filter(Boolean),
    ]
    const marks = ['', stop.severityMark, stop.typeMark, '', '', '', '']
    const sizes = [9, 8, 8, 8, 7.5, 9, 8]
    const wrapped = presets.map((lines, index) => {
      const emojiPad = marks[index] ? 16 : 0
      const width = STOP_COLUMNS[index].width - 10 - emojiPad
      return lines.flatMap(line => wrapToWidth(line, width, sizes[index]))
    })
    const lineCount = Math.max(...wrapped.map(lines => Math.max(lines.length, 1)))
    const rowHeight = Math.max(22, 10 + lineCount * 11)
    if (y - rowHeight < BOTTOM) startPage(true)
    const bottom = y - rowHeight
    fillRect(LEFT, bottom, TABLE_W, rowHeight, [1, 1, 1])
    strokeRect(LEFT, bottom, TABLE_W, rowHeight, rule)
    let x = LEFT
    page.commands.push(`${rule[0]} ${rule[1]} ${rule[2]} RG`)
    for (let index = 0; index < STOP_COLUMNS.length - 1; index += 1) {
      x += STOP_COLUMNS[index].width
      page.commands.push(`${num(x)} ${num(bottom)} m ${num(x)} ${num(bottom + rowHeight)} l S`)
    }
    x = LEFT
    wrapped.forEach((_, index) => {
      const lines = wrapped[index].length ? wrapped[index] : ['']
      const firstBaseline = bottom + rowHeight - 14
      const mark = marks[index] ? useEmoji(marks[index], '#ffffff') : null
      if (mark) imageAt(mark, x + 4, firstBaseline - 2, 11)
      lines.forEach((line, lineIndex) => {
        text(x + (mark ? 18 : 5), firstBaseline - lineIndex * 11, line, sizes[index], index === 0, ink)
      })
      x += STOP_COLUMNS[index].width
    })
    y = bottom
    drawNote(stop)
  }

  function drawNote(stop: DispatchStop) {
    const parts = [stop.needs ? `Needs: ${stop.needs}` : '', stop.summary].filter(Boolean)
    if (!parts.length) return
    const lines = wrapToWidth(parts.join('   '), TABLE_W - 36, 8)
    let index = 0
    while (index < lines.length) {
      const room = y - BOTTOM
      if (room < 20) {
        startPage(true)
        continue
      }
      const maxLines = Math.max(1, Math.floor((room - 8) / 10))
      const chunk = lines.slice(index, index + maxLines)
      const height = 8 + chunk.length * 10
      const bottom = y - height
      fillRect(LEFT, bottom, TABLE_W, height, [0.97, 0.98, 0.97])
      strokeRect(LEFT, bottom, TABLE_W, height, rule)
      const mark = useEmoji(stop.summary ? '💬' : '🩹', '#f7faf7')
      if (mark && index === 0) imageAt(mark, LEFT + 5, bottom + height - 16, 10)
      chunk.forEach((line, lineIndex) => {
        text(LEFT + 20, bottom + height - 13 - lineIndex * 10, line, 8, false, [0.25, 0.32, 0.29])
      })
      y = bottom
      index += chunk.length
    }
  }

  pages.forEach((item, index) => {
    const label = `${index + 1} / ${pages.length}`
    item.commands.push('0.42 0.48 0.45 rg')
    item.commands.push(`BT /F1 8 Tf 1 0 0 1 ${LEFT} 28 Tm (${pdfEscape(`NET0 dispatch #${code}`)}) Tj ET`)
    item.commands.push(
      `BT /F1 8 Tf 1 0 0 1 ${num(RIGHT - estimateWidth(label, 8))} 28 Tm (${pdfEscape(label)}) Tj ET`,
    )
  })

  const imageStart = 5
  const contentStart = imageStart + images.length
  const pageObjectIds = pages.map((_, index) => contentStart + index * 2 + 1)
  const chunks: Uint8Array[] = []
  let length = 0
  const offsets: number[] = []
  const encoder = new TextEncoder()

  function writeText(value: string) {
    const bytes = encoder.encode(value)
    chunks.push(bytes)
    length += bytes.length
  }

  function writeBytes(bytes: Uint8Array) {
    chunks.push(bytes)
    length += bytes.length
  }

  writeText('%PDF-1.4\n%')
  writeBytes(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  function beginObject() {
    offsets.push(length)
  }

  beginObject()
  writeText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  beginObject()
  writeText(
    `2 0 obj\n<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] >>\nendobj\n`,
  )
  beginObject()
  writeText('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')
  beginObject()
  writeText('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n')

  images.forEach((image, index) => {
    beginObject()
    writeText(
      `${imageStart + index} 0 obj\n<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`,
    )
    writeBytes(image.jpeg)
    writeText('\nendstream\nendobj\n')
  })

  pages.forEach((item, index) => {
    const contentId = contentStart + index * 2
    const pageId = contentId + 1
    const stream = encoder.encode(item.commands.join('\n'))
    const xobjects = [...item.images]
      .map(name => {
        const imageIndex = images.findIndex(image => image.name === name)
        return `/${name} ${imageStart + imageIndex} 0 R`
      })
      .join(' ')
    const xobjectDict = xobjects ? ` /XObject << ${xobjects} >>` : ''
    beginObject()
    writeText(`${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n`)
    writeBytes(stream)
    writeText('\nendstream\nendobj\n')
    beginObject()
    writeText(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjectDict} >> >>\nendobj\n`,
    )
  })

  const xref = length
  const count = offsets.length + 1
  writeText(`xref\n0 ${count}\n`)
  writeText('0000000000 65535 f \n')
  for (const offset of offsets) writeText(`${String(offset).padStart(10, '0')} 00000 n \n`)
  writeText(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)

  const bytes = new Uint8Array(length)
  let cursor = 0
  for (const chunk of chunks) {
    bytes.set(chunk, cursor)
    cursor += chunk.length
  }
  return bytes
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function downloadDispatchPdf(orderNumber: number, incidents: Incident[]) {
  const bytes = renderDispatchPdf(orderNumber, incidents)
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  downloadBlob(`NET0-dispatch-${dispatchCode(orderNumber)}.pdf`, new Blob([copy], { type: 'application/pdf' }))
}
