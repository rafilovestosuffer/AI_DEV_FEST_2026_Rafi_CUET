import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'
import { todayISO } from './logic.js'

const FOOTER_H = 30 // reserved band at the bottom of every page; content is scaled to sit above it
const A4 = [595.28, 841.89]

export const MAX_FILES = 30
export const MAX_BYTES = 50 * 1024 * 1024

async function sha256(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Check a file is a real, readable, unlocked PDF; count pages; hash content.
// Returns { bytes, hash, pages } or { error: 'notPdf' | 'encrypted' | 'damaged' }.
export async function inspectFile(file) {
  const isPdfName = /\.pdf$/i.test(file.name)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024))
  if (!head.includes('%PDF-')) return { error: 'notPdf' }
  if (!isPdfName && file.type && file.type !== 'application/pdf') return { error: 'notPdf' }
  const hash = await sha256(bytes)
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const pages = doc.getPageCount()
    if (!pages) return { error: 'damaged' }
    return { bytes, hash, pages }
  } catch (e) {
    return { error: /encrypt/i.test(String(e && e.message)) ? 'encrypted' : 'damaged' }
  }
}

// Standard PDF fonts only cover Latin-1; replace anything else so drawing never throws.
const safe = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')

function wrap(text, font, size, maxW) {
  const words = safe(text).split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    const t = line ? line + ' ' + w : w
    if (line && font.widthOfTextAtSize(t, size) > maxW) { lines.push(line); line = w } else line = t
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function fitText(text, font, size, maxW) {
  let s = safe(text)
  if (font.widthOfTextAtSize(s, size) <= maxW) return s
  while (s.length > 1 && font.widthOfTextAtSize(s + '...', size) > maxW) s = s.slice(0, -1)
  return s + '...'
}

// Draw one source page scaled into the area above the footer band, honouring /Rotate.
function drawScaled(out, src, emb) {
  const rot = ((src.getRotation().angle % 360) + 360) % 360
  const ew = emb.width
  const eh = emb.height
  const side = rot === 90 || rot === 270
  const W = side ? eh : ew // displayed size
  const H = side ? ew : eh
  const page = out.addPage([W, H])
  const s = (H - FOOTER_H) / H
  const x0 = (W - W * s) / 2
  const y0 = FOOTER_H
  const opts = { xScale: s, yScale: s }
  if (rot === 0) page.drawPage(emb, { ...opts, x: x0, y: y0 })
  else if (rot === 90) page.drawPage(emb, { ...opts, x: x0, y: y0 + ew * s, rotate: degrees(-90) })
  else if (rot === 180) page.drawPage(emb, { ...opts, x: x0 + ew * s, y: y0 + eh * s, rotate: degrees(180) })
  else page.drawPage(emb, { ...opts, x: x0 + eh * s, y: y0, rotate: degrees(90) })
  return page
}

// Fallback if a page cannot be embedded: copy it and grow the page downward for the footer band.
function copyWithBand(page) {
  const box = page.getCropBox()
  const rot = ((page.getRotation().angle % 360) + 360) % 360
  if (rot !== 0) return page // rare; footer still drawn by caller in page coordinates
  page.setMediaBox(box.x, box.y - FOOTER_H, box.width, box.height + FOOTER_H)
  page.setCropBox(box.x, box.y - FOOTER_H, box.width, box.height + FOOTER_H)
  return page
}

// items: [{ req, file }] sorted by order, only requirements that have a file.
// opts.bnTitles: { reqId: {bytes,w,h} } PNG images of Bangla titles for the index page.
// opts.seal: { bytes (PNG), pages: Set of package page numbers, width (pt) }.
// opts.textImages: { text: {bytes,w,h} } PNG images for cover values that use non-Latin script (e.g. Bangla).
export async function buildPackage(tender, items, { withIndex = true, bnTitles = null, seal = null, textImages = null } = {}) {
  const out = await PDFDocument.create()
  out.setTitle(`${safe(tender.tender_id)} Package`)
  out.setCreator('Tender Package Builder')
  const font = await out.embedFont(StandardFonts.Helvetica)
  const bold = await out.embedFont(StandardFonts.HelveticaBold)
  const left = 56
  const maxW = A4[0] - 2 * left
  const ink = rgb(0.1, 0.1, 0.12)
  const muted = rgb(0.4, 0.4, 0.45)

  const front = withIndex ? 2 : 1
  const starts = []
  let next = front + 1
  for (const it of items) { starts.push(next); next += it.file.pages }
  const total = next - 1

  // ---- Cover page (English) ----
  const cover = out.addPage(A4)
  let y = A4[1] - 70
  cover.drawText('TENDER SUBMISSION PACKAGE', { x: left, y, size: 20, font: bold, color: ink })
  y -= 12
  cover.drawLine({ start: { x: left, y }, end: { x: A4[0] - left, y }, thickness: 1.2, color: ink })
  y -= 30
  const rows = [
    ['Tender ID', tender.tender_id],
    ['Tender Title', tender.title],
    ['Procuring Entity', tender.procuring_entity],
    ['Bidder', tender.bidder],
    ['Submission Deadline', tender.submission_deadline],
    ['Package Created', todayISO()],
  ]
  for (const [k, v] of rows) {
    cover.drawText(k + ':', { x: left, y, size: 11.5, font: bold, color: ink })
    // Standard PDF fonts cannot show Bangla: draw such values as a browser-rendered image instead of "???"
    const img = textImages && /[^\x00-\xFF]/.test(String(v ?? '')) && textImages[v]
    if (img) {
      try {
        const png = await out.embedPng(img.bytes)
        let h = 11.5 * 1.55
        let w = (img.w / img.h) * h
        const room = maxW - 150
        if (w > room) { h *= room / w; w = room }
        cover.drawImage(png, { x: left + 150, y: y - h * 0.3, width: w, height: h })
        y -= 15 + 8
        continue
      } catch { /* fall back to plain text */ }
    }
    const lines = wrap(v, font, 11.5, maxW - 150)
    lines.forEach((ln, i) => cover.drawText(ln, { x: left + 150, y: y - i * 15, size: 11.5, font, color: ink }))
    y -= 15 * lines.length + 8
  }
  y -= 18
  cover.drawText('Included Documents (in order)', { x: left, y, size: 13.5, font: bold, color: ink })
  y -= 22
  const lineH = items.length > 22 ? Math.max(11, Math.floor((y - FOOTER_H - 20) / items.length)) : 18
  const fs = Math.min(11, lineH - 4)
  items.forEach((it, i) => {
    const pg = it.file.pages
    const label = `${i + 1}. ${it.req.title_en}`
    cover.drawText(fitText(label, font, fs, maxW - 150), { x: left + 6, y, size: fs, font, color: ink })
    const right = `${pg} page${pg === 1 ? '' : 's'}`
    cover.drawText(right, { x: A4[0] - left - font.widthOfTextAtSize(right, fs), y, size: fs, font, color: muted })
    y -= lineH
  })

  // ---- Index page (bonus): start page of each document ----
  if (withIndex) {
    const index = out.addPage(A4)
    let iy = A4[1] - 70
    index.drawText('INDEX', { x: left, y: iy, size: 20, font: bold, color: ink })
    iy -= 12
    index.drawLine({ start: { x: left, y: iy }, end: { x: A4[0] - left, y: iy }, thickness: 1.2, color: ink })
    iy -= 26
    index.drawText('Document', { x: left, y: iy, size: 11, font: bold, color: ink })
    index.drawText('Pages', { x: A4[0] - left - 150, y: iy, size: 11, font: bold, color: ink })
    index.drawText('Starts on page', { x: A4[0] - left - font.widthOfTextAtSize('Starts on page', 11) - 2, y: iy, size: 11, font: bold, color: ink })
    iy -= 20
    const hasBn = bnTitles && items.some((it) => bnTitles[it.req.id])
    const ih = items.length > 24 ? Math.max(11, Math.floor((iy - FOOTER_H - 20) / items.length)) : hasBn ? 24 : 19
    const ifs = Math.min(11, ih - 4)
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const label = fitText(`${i + 1}. ${it.req.title_en}`, font, ifs, maxW - 170)
      index.drawText(label, { x: left, y: iy, size: ifs, font, color: ink })
      const bn = hasBn && bnTitles[it.req.id]
      if (bn) {
        try {
          const img = await out.embedPng(bn.bytes)
          const x = left + font.widthOfTextAtSize(label, ifs) + 8
          const room = A4[0] - left - 160 - x
          let h = ifs * 1.55
          let w = (bn.w / bn.h) * h
          if (w > room) { h *= room / w; w = room }
          if (w > 10) index.drawImage(img, { x, y: iy - h * 0.3, width: w, height: h })
        } catch { /* Bangla image is optional */ }
      }
      index.drawText(String(it.file.pages), { x: A4[0] - left - 140, y: iy, size: ifs, font, color: muted })
      const sp = String(starts[i])
      index.drawText(sp, { x: A4[0] - left - font.widthOfTextAtSize(sp, ifs) - 2, y: iy, size: ifs, font, color: ink })
      iy -= ih
    }
  }

  // ---- Documents: all pages in original order ----
  for (const it of items) {
    const src = await PDFDocument.load(it.file.bytes, { updateMetadata: false })
    const srcPages = src.getPages()
    for (let i = 0; i < srcPages.length; i++) {
      const sp = srcPages[i]
      try {
        const cb = sp.getCropBox()
        const emb = await out.embedPage(sp, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height })
        drawScaled(out, sp, emb)
      } catch {
        const [copied] = await out.copyPages(src, [i])
        out.addPage(copyWithBand(copied))
      }
    }
  }

  // ---- Seal / signature (bonus) on chosen package pages, above the footer band ----
  if (seal && seal.bytes && seal.pages && seal.pages.size) {
    const img = await out.embedPng(seal.bytes)
    const w = seal.width || 90
    const h = (img.height / img.width) * w
    out.getPages().forEach((page, i) => {
      if (!seal.pages.has(i + 1)) return
      const box = page.getCropBox()
      page.drawImage(img, { x: box.x + box.width - w - 36, y: box.y + FOOTER_H + 14, width: w, height: h })
    })
  }

  // ---- Footer on every page: "<tender_id> | Page X of Y" ----
  const pages = out.getPages()
  if (pages.length !== total) throw new Error(`page count mismatch (${pages.length} vs ${total})`)
  pages.forEach((page, i) => {
    const box = page.getCropBox()
    const text = safe(`${tender.tender_id} | Page ${i + 1} of ${total}`)
    const size = 10
    const w = font.widthOfTextAtSize(text, size)
    page.drawRectangle({ x: box.x, y: box.y, width: box.width, height: FOOTER_H - 2, color: rgb(1, 1, 1) })
    page.drawLine({ start: { x: box.x + 30, y: box.y + FOOTER_H - 4 }, end: { x: box.x + box.width - 30, y: box.y + FOOTER_H - 4 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) })
    page.drawText(text, { x: box.x + (box.width - w) / 2, y: box.y + 10, size, font, color: rgb(0, 0, 0) })
  })

  return { bytes: await out.save(), total, starts }
}
