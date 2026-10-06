// Browser-only helpers: first-page thumbnail, text, expiry-date detection (pdf.js),
// and Bangla text rendered to PNG through the browser's text shaping (for the PDF index page).
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n) => String(n).padStart(2, '0')
const BN = '০১২৩৪৫৬৭৮৯'

function valid(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return y > 1990 && y < 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null
}

// All dates found in a string, in order of appearance, as YYYY-MM-DD.
function datesIn(s) {
  const out = []
  const push = (i, v) => v && out.push({ i, v })
  let m
  const iso = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g
  while ((m = iso.exec(s))) push(m.index, valid(+m[1], +m[2], +m[3]))
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g // Bangladesh: day first
  while ((m = dmy.exec(s))) push(m.index, valid(+m[3], +m[2], +m[1]))
  const dMonY = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/g
  while ((m = dMonY.exec(s))) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mi >= 0) push(m.index, valid(+m[3], mi + 1, +m[1])) }
  const monDY = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g
  while ((m = monDY.exec(s))) { const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (mi >= 0) push(m.index, valid(+m[3], mi + 1, +m[2])) }
  return out.sort((a, b) => a.i - b.i)
}

// Only trust a date that follows an expiry/validity keyword, never a random date (e.g. issue date).
export function findExpiry(text) {
  const s = String(text).replace(/[০-৯]/g, (d) => BN.indexOf(d)).replace(/\s+/g, ' ')
  const kw = /(valid\s*(until|upto|up to|till|through|thru)|validity|expiry|expires?|expiration|date of expiry|মেয়াদ)/gi
  let m
  while ((m = kw.exec(s))) {
    const win = s.slice(m.index, m.index + 120)
    const d = datesIn(win)
    if (d.length) return d[0].v
  }
  return null
}

// Thumbnail of page 1 + text of the first pages. Never throws.
export async function analyzePdf(bytes) {
  try {
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false })
    const doc = await task.promise
    let text = ''
    for (let p = 1; p <= Math.min(doc.numPages, 3); p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      text += tc.items.map((it) => it.str).join(' ') + '\n'
    }
    const page = await doc.getPage(1)
    const vp0 = page.getViewport({ scale: 1 })
    const vp = page.getViewport({ scale: 140 / vp0.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(vp.width)
    canvas.height = Math.ceil(vp.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise
    const thumb = canvas.toDataURL('image/jpeg', 0.75)
    task.destroy()
    return { thumb, text: text.trim(), scanned: text.trim().length < 20, expiryHint: findExpiry(text) }
  } catch (e) {
    console.warn('PDF preview failed:', e)
    return { thumb: null, text: '', scanned: false, expiryHint: null }
  }
}

// Render Bangla text to a PNG with correct shaping (canvas uses the browser's text engine).
let fontReady = null
export async function bnToPng(text, px = 44) {
  if (!fontReady) fontReady = document.fonts.load(`${px}px "Noto Sans Bengali"`).catch(() => {})
  await fontReady
  const font = `${px}px "Noto Sans Bengali", "Nirmala UI", "Vrinda", sans-serif`
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 4
  const h = Math.ceil(px * 1.5)
  c.width = w
  c.height = h
  ctx.font = font
  ctx.fillStyle = '#1a1a1f'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 2, h / 2)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h }
}
