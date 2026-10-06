// Pure rules: requirements parsing, status, blocking, auto-match.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// true, "true", "yes", 1 all count as true (tolerant of hand-written JSON)
const truthy = (v) => v === true || v === 1 || /^(true|yes|y|1)$/i.test(String(v ?? '').trim())

export function parseRequirements(text) {
  const data = JSON.parse(String(text).replace(/^\uFEFF/, ''))
  const t = data && data.tender
  if (!t || typeof t !== 'object') throw new Error('missing "tender"')
  if (!t.tender_id) throw new Error('missing tender_id')
  const dl = String(t.submission_deadline || '').trim().slice(0, 10) // tolerate a time part
  if (!DATE_RE.test(dl)) throw new Error('bad submission_deadline')
  if (!Array.isArray(data.requirements) || data.requirements.length === 0) throw new Error('missing requirements')
  const reqs = data.requirements.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`requirement ${i + 1} is not an object`)
    const ord = parseFloat(r.order)
    return {
      id: String(r.id ?? `R${i + 1}`),
      order: Number.isFinite(ord) ? ord : 1000 + i, // missing order: keep file order, after numbered ones
      title_en: String(r.title_en || r.title_bn || r.id),
      title_bn: String(r.title_bn || r.title_en || r.id),
      mandatory: truthy(r.mandatory),
      has_expiry: truthy(r.has_expiry),
    }
  })
  const ids = new Set(reqs.map((r) => r.id))
  if (ids.size !== reqs.length) throw new Error('duplicate requirement id')
  reqs.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  return {
    tender: {
      tender_id: String(t.tender_id),
      title: String(t.title || ''),
      procuring_entity: String(t.procuring_entity || ''),
      bidder: String(t.bidder || ''),
      submission_deadline: dl,
    },
    requirements: reqs,
  }
}

// Status per Section 5 of the problem statement.
export function computeStatus(req, fileId, expiry, deadline) {
  if (!fileId) return req.mandatory ? 'missing' : 'notProvided'
  if (req.has_expiry) {
    if (!expiry || !DATE_RE.test(expiry)) return 'expiryNeeded'
    if (expiry < deadline) return 'expired' // same day as deadline is still OK
  }
  return 'ok'
}

export const BLOCKING = new Set(['missing', 'expiryNeeded', 'expired'])
export const isBlocking = (status) => BLOCKING.has(status)

// Map file id -> list of other file ids with exactly the same content.
export function duplicateGroups(files) {
  const byHash = {}
  for (const f of files) (byHash[f.hash] ||= []).push(f)
  const dup = {}
  for (const f of files) {
    const same = byHash[f.hash].filter((g) => g.id !== f.id)
    if (same.length) dup[f.id] = same
  }
  return dup
}

// Why a file cannot be chosen for requirement reqId (null = allowed).
export function blockReason(file, reqId, matches, files) {
  for (const [rid, fid] of Object.entries(matches)) {
    if (rid === reqId || !fid) continue
    if (fid === file.id) return { kind: 'used', reqId: rid }
    const other = files.find((f) => f.id === fid)
    if (other && other.hash === file.hash) return { kind: 'dup', reqId: rid }
  }
  return null
}

// ---- Auto-match from file names ----
const SYN = {
  license: ['license', 'licence', 'lic'],
  licence: ['license', 'licence', 'lic'],
  tin: ['tin', 'etin', 'taxpayer'],
  vat: ['vat', 'bin'],
  solvency: ['solvency', 'solvent'],
  bank: ['bank'],
  experience: ['experience', 'exp', 'work'],
  technical: ['technical', 'tech'],
  financial: ['financial', 'finance', 'fin', 'price'],
  proposal: ['proposal', 'offer'],
  declaration: ['declaration', 'decl', 'declare'],
  signed: ['signed'],
  audited: ['audited', 'audit'],
  statement: ['statement', 'statements'],
  manufacturer: ['manufacturer', 'manufacturers', 'mfr', 'maf', 'oem'],
  authorization: ['authorization', 'authorisation', 'auth', 'maf'],
  trade: ['trade'],
  registration: ['registration', 'reg'],
}
const WEAK = new Set(['certificate', 'cert', 'letter', 'document', 'copy'])
const STOP = new Set(['of', 'the', 'and', 'for', 'a', 'an', 's'])

const tokens = (s) =>
  String(s).toLowerCase().replace(/\.pdf$/i, '').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w))

function score(req, fileName) {
  const ft = new Set(tokens(fileName))
  let s = 0
  for (const w of tokens(req.title_en)) {
    if (WEAK.has(w)) { if (ft.has(w) || ft.has('cert')) s += 0.2; continue }
    const alts = SYN[w] || [w]
    if (alts.some((a) => ft.has(a))) s += 1
  }
  return s
}

const latestYear = (name) => Math.max(0, ...(String(name).match(/20\d\d/g) || []).map(Number))

// Returns a new matches object; fills only empty rows and unused files.
export function autoMatch(requirements, files, matches) {
  const next = { ...matches }
  const usedHashes = new Set(
    Object.values(next).filter(Boolean).map((fid) => files.find((f) => f.id === fid)?.hash),
  )
  const pairs = []
  for (const r of requirements) {
    if (next[r.id]) continue
    for (const f of files) {
      // file name first; first-page text (if any) as a weaker signal for badly named files
      const s = Math.max(score(r, f.name), f.text ? 0.9 * score(r, f.text.slice(0, 300)) : 0)
      if (s >= 1) pairs.push({ r, f, s, y: latestYear(f.name) })
    }
  }
  pairs.sort((a, b) => b.s - a.s || b.y - a.y || a.f.name.length - b.f.name.length)
  let added = 0
  for (const p of pairs) {
    if (next[p.r.id] || usedHashes.has(p.f.hash)) continue
    next[p.r.id] = p.f.id
    usedHashes.add(p.f.hash)
    added++
  }
  return { matches: next, added }
}

export function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
