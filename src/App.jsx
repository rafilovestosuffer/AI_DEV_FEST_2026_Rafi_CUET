import { useMemo, useRef, useState } from 'react'
import { T } from './i18n.js'
import { inspectFile, statusOf, BLOCKING, buildPackage } from './pdf.js'

const MAX_FILES = 30
const MAX_BYTES = 50 * 1024 * 1024
const SAVE_KEY = 'tender-package-builder:v1'

let nextId = 1

function validRequirements(j) {
  return (
    j && j.tender && typeof j.tender.tender_id === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(j.tender.submission_deadline || '') &&
    Array.isArray(j.requirements) &&
    j.requirements.every((r) => r.id && typeof r.order === 'number' && r.title_en)
  )
}

// Score how well a file name fits a requirement title (bonus: auto-match).
const KEYWORDS = {
  trade: ['trade', 'license', 'licence'], tin: ['tin'], vat: ['vat', 'bin'],
  bank: ['bank', 'solvency'], experience: ['experience', 'exp'],
  audit: ['audit', 'audited', 'financial_statement', 'statement'],
  manufacturer: ['manufacturer', 'authorization', 'authorisation', 'maf'],
  technical: ['technical'], financial: ['financial', 'price'], declaration: ['declaration', 'signed'],
}
function matchScore(name, title) {
  const n = name.toLowerCase()
  const words = title.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2)
  let s = 0
  for (const w of words) if (n.includes(w)) s += 2
  for (const keys of Object.values(KEYWORDS)) {
    if (keys.some((k) => title.toLowerCase().includes(k)) && keys.some((k) => n.includes(k))) s += 1
  }
  if (/statement/.test(title.toLowerCase()) && !/statement|audit/.test(n)) s -= 3
  return s
}

export default function App() {
  const [lang, setLang] = useState('en')
  const t = T[lang]
  const [reqData, setReqData] = useState(null)
  const [jsonError, setJsonError] = useState('')
  const [files, setFiles] = useState([]) // {id, name, size, pages, hash, bytes}
  const [messages, setMessages] = useState([])
  const [match, setMatch] = useState({}) // reqId -> fileId
  const [expiry, setExpiry] = useState({}) // reqId -> 'YYYY-MM-DD'
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [notice, setNotice] = useState('')
  const pendingRestore = useRef(null) // reqId -> hash, from saved work

  const reqs = useMemo(
    () => (reqData ? [...reqData.requirements].sort((a, b) => a.order - b.order) : []),
    [reqData]
  )
  const deadline = reqData?.tender.submission_deadline
  const reqTitle = (r) => (lang === 'bn' ? r.title_bn || r.title_en : r.title_en)
  const fileById = (id) => files.find((f) => f.id === id)

  // Duplicate groups by content hash
  const dupOf = useMemo(() => {
    const m = {}
    for (const f of files) {
      const same = files.filter((g) => g.hash === f.hash && g.id !== f.id)
      if (same.length) m[f.id] = same
    }
    return m
  }, [files])

  const rows = reqs.map((r) => {
    const f = match[r.id] ? fileById(match[r.id]) : null
    return { r, f, status: statusOf(r, f, expiry[r.id], deadline) }
  })
  const blocking = rows.filter((x) => BLOCKING.includes(x.status))
  const canGenerate = reqData && blocking.length === 0 && !busy

  function invalidate() {
    if (result?.url) URL.revokeObjectURL(result.url)
    setResult(null)
  }

  async function onJson(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    try {
      const j = JSON.parse(await file.text())
      if (!validRequirements(j)) throw new Error()
      setReqData(j)
      setJsonError('')
      setMatch({})
      setExpiry({})
      invalidate()
    } catch {
      setJsonError(t.badJson)
    }
  }

  async function onPdfs(e) {
    const list = [...e.target.files]
    e.target.value = ''
    const msgs = []
    if (files.length + list.length > MAX_FILES) {
      setMessages([t.tooMany])
      return
    }
    const totalSize = files.reduce((s, f) => s + f.size, 0) + list.reduce((s, f) => s + f.size, 0)
    if (totalSize > MAX_BYTES) {
      setMessages([t.tooBig])
      return
    }
    const added = []
    for (const file of list) {
      const info = await inspectFile(file)
      if (info.error) {
        msgs.push(`"${file.name}" ${t[info.error]}`)
        continue
      }
      added.push({ id: nextId++, name: file.name, size: file.size, ...info })
    }
    setFiles((prev) => [...prev, ...added])
    // Re-apply saved matches (by content hash) after "Open saved work"
    if (pendingRestore.current) {
      setMatch((prev) => {
        const m = { ...prev }
        for (const [rid, hash] of Object.entries(pendingRestore.current)) {
          const f = added.find((x) => x.hash === hash)
          if (f && !m[rid]) m[rid] = f.id
        }
        return m
      })
    }
    setMessages(msgs)
    invalidate()
  }

  function removeFile(id) {
    setFiles((prev) => prev.filter((f) => f.id !== id))
    setMatch((prev) => Object.fromEntries(Object.entries(prev).filter(([, fid]) => fid !== id)))
    invalidate()
  }

  // Why a file cannot be chosen for a requirement (null = allowed)
  function blockedReason(reqId, f) {
    const usedBy = Object.entries(match).find(([rid, fid]) => fid === f.id && rid !== reqId)
    if (usedBy) return 'used'
    const dupUsed = Object.entries(match).some(
      ([rid, fid]) => rid !== reqId && fid !== f.id && fileById(fid)?.hash === f.hash
    )
    if (dupUsed) return 'dup'
    return null
  }

  function setReqFile(reqId, val) {
    setMatch((prev) => {
      const m = { ...prev }
      if (!val) delete m[reqId]
      else m[reqId] = Number(val)
      return m
    })
    invalidate()
  }

  function autoMatch() {
    const m = { ...match }
    const used = new Set(Object.values(m))
    const usedHash = new Set(Object.values(m).map((id) => fileById(id)?.hash))
    for (const r of reqs) {
      if (m[r.id]) continue
      let best = null
      let bestScore = 1
      for (const f of files) {
        if (used.has(f.id) || usedHash.has(f.hash)) continue
        const s = matchScore(f.name, r.title_en)
        if (s > bestScore) {
          best = f
          bestScore = s
        }
      }
      if (best) {
        m[r.id] = best.id
        used.add(best.id)
        usedHash.add(best.hash)
      }
    }
    setMatch(m)
    setNotice(t.autoMatched)
    invalidate()
  }

  async function generate() {
    setBusy(true)
    try {
      const items = rows.filter((x) => x.f).map((x) => ({ req: x.r, file: x.f }))
      const { bytes, total } = await buildPackage(reqData.tender, items)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      setResult({ url, total, name: `${reqData.tender.tender_id}_Package.pdf` })
    } catch (e) {
      setNotice(`${t.genError} ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  function exportCsv() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [['Order', 'Document', 'File name', 'Pages', 'Expiry date', 'Status'].join(',')]
    for (const { r, f, status } of rows) {
      lines.push([r.order, r.title_en, f?.name, f?.pages, r.has_expiry ? expiry[r.id] : '', T.en['st_' + status]].map(esc).join(','))
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${reqData.tender.tender_id}_Checklist.csv`
    a.click()
  }

  function saveWork() {
    const byHash = {}
    for (const [rid, fid] of Object.entries(match)) {
      const f = fileById(fid)
      if (f) byHash[rid] = f.hash
    }
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ reqData, expiry, byHash, lang }))
      setNotice(t.saved)
    } catch {
      setNotice('Storage not available')
    }
  }

  function openWork() {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY))
      if (!s) throw new Error()
      setReqData(s.reqData)
      setExpiry(s.expiry || {})
      setMatch({})
      setFiles([])
      pendingRestore.current = s.byHash || {}
      setNotice(T[lang].restored)
      invalidate()
    } catch {
      setNotice(t.noSaved)
    }
  }

  const reqForFile = (id) => {
    const e = Object.entries(match).find(([, fid]) => fid === id)
    return e ? reqs.find((r) => r.id === e[0]) : null
  }

  return (
    <div className="app" lang={lang}>
      <header>
        <div>
          <h1>{t.appTitle}</h1>
          <p className="muted">{t.subtitle}</p>
        </div>
        <div className="head-actions">
          <button className="lang" onClick={() => setLang(lang === 'en' ? 'bn' : 'en')}>{t.lang}</button>
          <button className="ghost" onClick={openWork}>{t.openProject}</button>
        </div>
      </header>
      <p className="privacy">🔒 {t.privacy}</p>
      {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}

      <section>
        <h2>{t.step1}</h2>
        <p className="muted">{t.step1Help}</p>
        <label className="btn">
          {t.chooseJson}
          <input type="file" accept=".json,application/json" onChange={onJson} hidden />
        </label>
        {jsonError && <p className="error">{jsonError}</p>}
        {reqData && (
          <dl className="tender">
            <dt>{t.tenderId}</dt><dd>{reqData.tender.tender_id}</dd>
            <dt>{t.title}</dt><dd>{reqData.tender.title}</dd>
            <dt>{t.entity}</dt><dd>{reqData.tender.procuring_entity}</dd>
            <dt>{t.bidder}</dt><dd>{reqData.tender.bidder}</dd>
            <dt>{t.deadline}</dt><dd><strong>{deadline}</strong></dd>
          </dl>
        )}
      </section>

      {reqData && (
        <section>
          <h2>{t.step2}</h2>
          <p className="muted">{t.step2Help}</p>
          <label className="btn">
            {t.choosePdfs}
            <input type="file" multiple onChange={onPdfs} hidden />
          </label>
          {messages.map((m, i) => <p key={i} className="error">⚠ {m}</p>)}
          {files.length === 0 ? (
            <p className="muted">{t.noFiles}</p>
          ) : (
            <table>
              <thead>
                <tr><th>{t.fileName}</th><th>{t.pages}</th><th>{t.matchedTo}</th><th></th></tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const r = reqForFile(f.id)
                  return (
                    <tr key={f.id} className={dupOf[f.id] ? 'dup' : ''}>
                      <td>
                        {f.name}
                        {dupOf[f.id] && (
                          <div className="badge warn">
                            {t.duplicate} — {t.duplicateOf} {dupOf[f.id].map((g) => g.name).join(', ')}
                          </div>
                        )}
                      </td>
                      <td>{f.pages}</td>
                      <td>{r ? reqTitle(r) : '—'}</td>
                      <td><button className="ghost" onClick={() => removeFile(f.id)}>{t.remove}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {reqData && (
        <section>
          <h2>{t.step3}</h2>
          <p className="muted">{t.step3Help}</p>
          {files.length > 0 && <button className="ghost" onClick={autoMatch}>{t.autoMatch}</button>}
          <table className="reqs">
            <thead>
              <tr><th>{t.order}</th><th>{t.document}</th><th>{t.file}</th><th>{t.expiry}</th><th>{t.status}</th></tr>
            </thead>
            <tbody>
              {rows.map(({ r, f, status }) => (
                <tr key={r.id}>
                  <td>{r.order}</td>
                  <td>
                    <strong>{reqTitle(r)}</strong>
                    <div className="muted small">{r.mandatory ? t.required : t.optional}</div>
                  </td>
                  <td>
                    <select value={match[r.id] || ''} onChange={(e) => setReqFile(r.id, e.target.value)}>
                      <option value="">{t.noneSelected}</option>
                      {files.map((g) => {
                        const why = blockedReason(r.id, g)
                        return (
                          <option key={g.id} value={g.id} disabled={!!why} title={why === 'dup' ? t.dupBlocked : ''}>
                            {g.name} ({g.pages}){why === 'dup' ? ` — ${t.duplicate}` : ''}
                          </option>
                        )
                      })}
                    </select>
                  </td>
                  <td>
                    {r.has_expiry ? (
                      f ? (
                        <input type="date" value={expiry[r.id] || ''} onChange={(e) => { setExpiry({ ...expiry, [r.id]: e.target.value }); invalidate() }} />
                      ) : <span className="muted small">—</span>
                    ) : <span className="muted small">{t.notNeeded}</span>}
                  </td>
                  <td><span className={`status s-${status}`}>{t['st_' + status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {reqData && (
        <section>
          <h2>{t.step4}</h2>
          {blocking.length > 0 ? (
            <div className="blockers">
              <p>{t.cannotGenerate}</p>
              <ul>
                {blocking.map(({ r, status }) => <li key={r.id}>{reqTitle(r)}: <strong>{t['st_' + status]}</strong></li>)}
              </ul>
            </div>
          ) : (
            <p className="ok-text">✔ {t.ready}</p>
          )}
          <div className="actions">
            <button className="primary" disabled={!canGenerate} onClick={generate}>
              {busy ? t.generating : t.generate}
            </button>
            <button className="ghost" onClick={exportCsv}>{t.exportCsv}</button>
            <button className="ghost" onClick={saveWork}>{t.saveProject}</button>
          </div>
          {result && (
            <div className="result">
              <p>✔ {t.done} — {t.totalPages}: {result.total}</p>
              <a className="btn primary" href={result.url} download={result.name}>⬇ {t.download} {result.name}</a>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
