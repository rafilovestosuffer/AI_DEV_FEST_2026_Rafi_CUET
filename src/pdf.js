import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const FOOTER_H = 28 // extra strip added under each page so the footer never covers content

// Read a file: check it is a real PDF, count pages, hash content.
export async function inspectFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const head = String.fromCharCode(...bytes.slice(0, 1024))
  const isPdfName = file.name.toLowerCase().endsWith('.pdf')
  if (!isPdfName || !head.includes('%PDF')) return { error: 'notPdf' }
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
  const hash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  try {
    const doc = await PDFDocument.load(bytes)
    return { bytes, hash, pages: doc.getPageCount() }
  } catch (e) {
    const msg = String(e && e.message)
    return { error: /encrypt/i.test(msg) ? 'encrypted' : 'damaged' }
  }
}

// Status of one requirement, per Section 5 of the problem statement.
export function statusOf(req, file, expiry, deadline) {
  if (!file) return req.mandatory ? 'missing' : 'notProvided'
  if (req.has_expiry) {
    if (!expiry) return 'expiryNeeded'
    if (expiry < deadline) return 'expired' // ISO dates compare correctly as strings
  }
  return 'ok'
}

export const BLOCKING = ['missing', 'expiryNeeded', 'expired']

export function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Helvetica only covers WinAnsi; drop anything else so cover text never crashes.
const safe = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?')

function wrap(text, font, size, maxW) {
  const words = safe(text).split(' ')
  const lines = []
  let line = ''
  for (const w of words) {
    const t = line ? line + ' ' + w : w
    if (font.widthOfTextAtSize(t, size) > maxW && line) {
      lines.push(line)
      line = w
    } else line = t
  }
  if (line) lines.push(line)
  return lines
}

// items: [{ req, file, expiry }] already sorted by order, only those with a file.
export async function buildPackage(tender, items, { withIndex = true } = {}) {
  const out = await PDFDocument.create()
  const font = await out.embedFont(StandardFonts.Helvetica)
  const bold = await out.embedFont(StandardFonts.HelveticaBold)
  const A4 = [595.28, 841.89]
  const made = todayISO()

  // Cover page
  const cover = out.addPage(A4)
  let y = 780
  const left = 60
  const maxW = A4[0] - 2 * left
  cover.drawText('TENDER SUBMISSION PACKAGE', { x: left, y, size: 20, font: bold })
  y -= 40
  const rows = [
    ['Tender ID', tender.tender_id],
    ['Tender Title', tender.title],
    ['Procuring Entity', tender.procuring_entity],
    ['Bidder', tender.bidder],
    ['Submission Deadline', tender.submission_deadline],
    ['Package Created', made],
  ]
  for (const [k, v] of rows) {
    cover.drawText(k + ':', { x: left, y, size: 11, font: bold })
    const lines = wrap(v, font, 11, maxW - 140)
    lines.forEach((ln, i) => cover.drawText(ln, { x: left + 140, y: y - i * 15, size: 11, font }))
    y -= 15 * Math.max(1, lines.length) + 6
  }
  y -= 14
  cover.drawText('Included Documents (in order)', { x: left, y, size: 13, font: bold })
  y -= 22
  items.forEach((it, i) => {
    const pg = it.file.pages
    const line = `${i + 1}. ${it.req.title_en}  (${pg} page${pg > 1 ? 's' : ''})`
    cover.drawText(safe(line), { x: left + 10, y, size: 11, font })
    y -= 17
  })

  // Index page (bonus): where each document starts
  let index = null
  if (withIndex) index = out.addPage(A4)
  const front = withIndex ? 2 : 1
  const starts = []
  let next = front + 1
  for (const it of items) {
    starts.push(next)
    next += it.file.pages
  }
  if (index) {
    let iy = 780
    index.drawText('INDEX', { x: left, y: iy, size: 20, font: bold })
    iy -= 36
    index.drawText('Document', { x: left, y: iy, size: 11, font: bold })
    index.drawText('Start page', { x: A4[0] - left - 70, y: iy, size: 11, font: bold })
    iy -= 20
    items.forEach((it, i) => {
      index.drawText(safe(`${i + 1}. ${it.req.title_en}`), { x: left, y: iy, size: 11, font })
      index.drawText(String(starts[i]), { x: A4[0] - left - 70, y: iy, size: 11, font })
      iy -= 18
    })
  }

  // Documents, all pages in original order
  for (const it of items) {
    const src = await PDFDocument.load(it.file.bytes)
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
  }

  // Footer on every page, in a strip added below the content
  const all = out.getPages()
  const total = all.length
  all.forEach((page, i) => {
    const box = page.getMediaBox()
    const nx = box.x
    const ny = box.y - FOOTER_H
    page.setMediaBox(nx, ny, box.width, box.height + FOOTER_H)
    page.setCropBox(nx, ny, box.width, box.height + FOOTER_H)
    page.drawRectangle({ x: nx, y: ny, width: box.width, height: FOOTER_H, color: rgb(1, 1, 1) })
    page.drawLine({ start: { x: nx, y: ny + FOOTER_H }, end: { x: nx + box.width, y: ny + FOOTER_H }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
    const text = safe(`${tender.tender_id} | Page ${i + 1} of ${total}`)
    const size = 10
    const w = font.widthOfTextAtSize(text, size)
    page.drawText(text, { x: nx + (box.width - w) / 2, y: ny + 10, size, font, color: rgb(0, 0, 0) })
  })

  return { bytes: await out.save(), total, starts }
}
