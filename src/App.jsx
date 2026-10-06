import { useEffect, useMemo, useState } from 'react'
import { T } from './i18n.js'
import { inspectFile, buildPackage, MAX_FILES, MAX_BYTES } from './pdf.js'
import { analyzePdf, bnToPng, pageImage } from './preview.js'
import { saveProject, loadProject } from './store.js'
import { aiSuggest } from './ai.js'
import { verifyPackage, VerifyPanel } from './verify.js'
import { parseRequirements, computeStatus, isBlocking, autoMatch as suggestMatches } from './logic.js'

let nextId = 1

export default function App() {
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem('tpb-lang') === 'bn' ? 'bn' : 'en' } catch { return 'en' }
  })
  useEffect(() => {
    document.documentElement.lang = lang
    try { localStorage.setItem('tpb-lang', lang) } catch { /* storage blocked */ }
  }, [lang])
  const [seal, setSeal] = useState(null) // { bytes, url, name }
  const [sealMode, setSealMode] = useState('last')
  const [sealCustom, setSealCustom] = useState('')
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
  const [dragOver, setDragOver] = useState(false)
  const [apiKey, setApiKey] = useState('') // kept in memory only, never saved
  const [aiBusy, setAiBusy] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  const reqs = reqData ? reqData.requirements : [] // already sorted by order in parseRequirements
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
    return { r, f, status: computeStatus(r, f?.id, expiry[r.id], deadline) }
  })
  const blocking = rows.filter((x) => isBlocking(x.status))
  const canGenerate = reqData && blocking.length === 0 && !busy
  const mandatoryRows = rows.filter((x) => x.r.mandatory)
  const readyCount = mandatoryRows.filter((x) => x.status === 'ok').length
  const daysAfter = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000)
  const hintRows = rows.filter(({ r, f }) => r.has_expiry && f && f.expiryHint && !expiry[r.id])
  const usedIds = new Set(Object.values(match))
  const usedHashes = new Set(files.filter((f) => usedIds.has(f.id)).map((f) => f.hash))
  const unusedFiles = files.filter((f) => !usedIds.has(f.id) && !usedHashes.has(f.hash))

  function invalidate() {
    if (result?.url) URL.revokeObjectURL(result.url)
    setResult(null)
  }

  async function onJson(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    try {
      setReqData(parseRequirements(await file.text()))
      setJsonError('')
      setMatch({})
      setExpiry({})
      invalidate()
    } catch {
      setJsonError(t.badJson)
    }
  }

  function onPdfs(e) {
    const list = [...e.target.files]
    e.target.value = ''
    addFiles(list)
  }

  async function addFiles(list) {
    if (!list.length) return
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
      added.push({ id: nextId++, name: file.name, size: file.size, url: URL.createObjectURL(new Blob([info.bytes], { type: 'application/pdf' })), ...info })
    }
    setFiles((prev) => [...prev, ...added])
    analyzeInBackground(added)
    setMessages(msgs)
    invalidate()
  }

  // Thumbnails, text and expiry hints load in the background so the list appears at once
  async function analyzeInBackground(list) {
    for (const f of list) {
      const extra = await analyzePdf(f.bytes)
      setFiles((prev) => prev.map((g) => (g.id === f.id ? { ...g, ...extra } : g)))
    }
  }

  function removeFile(id) {
    const gone = Object.entries(match).filter(([, fid]) => fid === id).map(([rid]) => rid)
    setFiles((prev) => prev.filter((f) => f.id !== id))
    setMatch((prev) => Object.fromEntries(Object.entries(prev).filter(([, fid]) => fid !== id)))
    setExpiry((prev) => Object.fromEntries(Object.entries(prev).filter(([rid]) => !gone.includes(rid))))
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
    // A different file needs its own expiry date
    setExpiry((prev) => {
      const x = { ...prev }
      delete x[reqId]
      return x
    })
    invalidate()
  }

  function autoMatch() {
    const { matches, added } = suggestMatches(reqs, files, match)
    setMatch(matches)
    setNotice(added ? t.autoMatched : t.autoNone)
    invalidate()
  }

  // Package page numbers that get the seal. Cover = 1, index = 2, documents start at 3.
  function sealPages(items) {
    const set = new Set()
    if (!seal || sealMode === 'none') return set
    let p = 3
    for (const it of items) {
      const first = p
      p += it.file.pages
      if (sealMode === 'last') set.add(p - 1)
      if (sealMode === 'all') for (let k = first; k < p; k++) set.add(k)
    }
    if (sealMode === 'custom') {
      for (const part of sealCustom.split(/[,\s]+/)) {
        const m = part.match(/^(\d+)(?:-(\d+))?$/)
        if (!m) continue
        const a = +m[1], b = m[2] ? +m[2] : a
        for (let k = Math.min(a, b); k <= Math.max(a, b) && k < p; k++) if (k >= 1) set.add(k)
      }
    }
    return set
  }

  async function onSeal(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    if (!isPng) { setNotice(t.sealBadPng); return }
    setSeal({ bytes, name: file.name, url: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) })
    invalidate()
  }

  async function generate() {
    setBusy(true)
    try {
      const items = rows.filter((x) => x.f).map((x) => ({ req: x.r, file: x.f }))
      const bnTitles = {}
      for (const it of items) {
        if (it.req.title_bn && it.req.title_bn !== it.req.title_en) {
          try { bnTitles[it.req.id] = await bnToPng(it.req.title_bn) } catch { /* optional */ }
        }
      }
      const pages = sealPages(items)
      const { bytes, total, starts } = await buildPackage(reqData.tender, items, {
        bnTitles,
        seal: seal && pages.size ? { bytes: seal.bytes, pages, width: 90 } : null,
      })
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      setResult({ url, total, name: `${reqData.tender.tender_id}_Package.pdf` })
      // Re-open the finished file and prove Section 6 on the real bytes
      verifyPackage(bytes, { tender: reqData.tender, items, starts, total }).then((report) => setResult((r) => (r && r.url === url ? { ...r, report } : r))).catch(() => {})
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

  async function saveWork() {
    try {
      const idx = Object.fromEntries(files.map((f, i) => [f.id, i]))
      await saveProject({
        reqData,
        expiry,
        match: Object.fromEntries(Object.entries(match).map(([rid, fid]) => [rid, idx[fid]])),
        files: files.map((f) => ({ name: f.name, size: f.size, bytes: f.bytes, hash: f.hash, pages: f.pages })),
        savedAt: new Date().toISOString(),
      })
      setNotice(t.saved)
    } catch (e) {
      setNotice(`${t.saveError} ${e.message || ''}`)
    }
  }

  async function openWork() {
    try {
      const s = await loadProject()
      if (!s || !s.reqData) { setNotice(t.noSaved); return }
      const restored = (s.files || []).map((f) => ({
        ...f,
        id: nextId++,
        url: URL.createObjectURL(new Blob([f.bytes], { type: 'application/pdf' })),
      }))
      const m = {}
      for (const [rid, i] of Object.entries(s.match || {})) if (restored[i]) m[rid] = restored[i].id
      setReqData(s.reqData)
      setFiles(restored)
      setMatch(m)
      setExpiry(s.expiry || {})
      setMessages([])
      setJsonError('')
      setNotice(`${t.restored} (${s.savedAt ? new Date(s.savedAt).toLocaleString() : ''})`)
      invalidate()
      analyzeInBackground(restored)
    } catch {
      setNotice(t.noSaved)
    }
  }

  async function askAi() {
    const emptyReqs = reqs.filter((r) => !match[r.id])
    if (!apiKey.trim()) { setNotice(t.aiNoKey); return }
    if (!emptyReqs.length || !unusedFiles.length) { setNotice(t.aiNothing); return }
    setAiBusy(true)
    try {
      const payload = []
      for (const f of unusedFiles) {
        payload.push({ name: f.name, text: f.text, image: f.scanned || !f.text ? await pageImage(f.bytes) : null })
      }
      const sugg = await aiSuggest({ apiKey: apiKey.trim(), requirements: emptyReqs, files: payload })
      const m = { ...match }
      const notes = []
      for (const sg of sugg) {
        const f = unusedFiles.find((x) => x.name === sg.file)
        const r = emptyReqs.find((x) => x.id === sg.req)
        if (!f || !r || m[r.id] || Object.values(m).includes(f.id)) continue
        if (Object.values(m).some((fid) => files.find((g) => g.id === fid)?.hash === f.hash)) continue
        m[r.id] = f.id
        notes.push(`${f.name} → ${reqTitle(r)} (${sg.reason || ''})`)
      }
      setMatch(m)
      setNotice(notes.length ? `${t.aiDone} ${notes.join('; ')}` : t.aiNone)
      invalidate()
    } catch (e) {
      setNotice(`${t.aiError} ${e.message}`)
    } finally {
      setAiBusy(false)
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
      {!online && <div className="offline">📴 {t.offline}</div>}
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
        <section
          className={dragOver ? 'drop over' : 'drop'}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles([...e.dataTransfer.files]) }}
        >
          <h2>{t.step2}</h2>
          <p className="muted">{t.step2Help}</p>
          <label className="btn">
            {t.choosePdfs}
            <input type="file" multiple onChange={onPdfs} hidden />
          </label>
          <span className="muted drop-hint"> {t.dropHere}</span>
          {messages.map((m, i) => <p key={i} className="error">⚠ {m}</p>)}
          {files.length === 0 ? (
            <p className="muted">{t.noFiles}</p>
          ) : (
            <div className="scroll">
            <table>
              <thead>
                <tr><th></th><th>{t.fileName}</th><th>{t.pages}</th><th>{t.size}</th><th>{t.matchedTo}</th><th></th></tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const r = reqForFile(f.id)
                  return (
                    <tr key={f.id} className={dupOf[f.id] ? 'dup' : ''}>
                      <td className="thumb-cell">
                        <a href={f.url} target="_blank" rel="noreferrer" title={t.view}>
                          {f.thumb ? <img className="thumb" src={f.thumb} alt="" /> : <span className="thumb ph">PDF</span>}
                        </a>
                      </td>
                      <td>
                        <a href={f.url} target="_blank" rel="noreferrer" className="fname" title={t.view}>{f.name}</a>
                        {f.scanned && <div className="badge info">{t.scanned}</div>}
                        {dupOf[f.id] && (
                          <div className="badge warn">
                            {t.duplicate} — {t.duplicateOf} {dupOf[f.id].map((g) => g.name).join(', ')}
                          </div>
                        )}
                      </td>
                      <td>{f.pages}</td>
                      <td className="nowrap">{(f.size / 1024).toFixed(0)} KB</td>
                      <td>{r ? <strong>{reqTitle(r)}</strong> : <span className="muted">{t.notUsed}</span>}</td>
                      <td><button className="ghost" onClick={() => removeFile(f.id)}>{t.remove}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </section>
      )}

      {reqData && (
        <section>
          <h2>{t.step3}</h2>
          <p className="muted">{t.step3Help}</p>
          {mandatoryRows.length > 0 && (
            <div className="ready" aria-label={t.readiness}>
              <div className="ready-text">{t.readiness}: <strong>{readyCount} / {mandatoryRows.length}</strong></div>
              <div className="bar"><span style={{ width: `${(100 * readyCount) / mandatoryRows.length}%` }} /></div>
            </div>
          )}
          <div className="toolbar">
            {files.length > 0 && <button className="ghost" onClick={autoMatch}>✨ {t.autoMatch}</button>}
            {hintRows.length > 0 && (
              <button className="ghost" onClick={() => { setExpiry((prev) => ({ ...prev, ...Object.fromEntries(hintRows.map(({ r, f }) => [r.id, f.expiryHint])) })); invalidate() }}>
                📅 {t.useAllDates} ({hintRows.length})
              </button>
            )}
            <div className="chips">
              {['ok', 'missing', 'expiryNeeded', 'expired', 'notProvided'].map((k) => {
                const n = rows.filter((x) => x.status === k).length
                return n ? <span key={k} className={`status s-${k}`}>{t['st_' + k]}: {n}</span> : null
              })}
            </div>
          </div>
          <div className="scroll">
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
                        <>
                          <input type="date" value={expiry[r.id] || ''} onChange={(e) => { setExpiry({ ...expiry, [r.id]: e.target.value }); invalidate() }} />
                          {f.expiryHint && expiry[r.id] !== f.expiryHint && (
                            <button className="hint" onClick={() => { setExpiry({ ...expiry, [r.id]: f.expiryHint }); invalidate() }}>
                              {t.foundInFile}: {f.expiryHint} — {t.useDate}
                            </button>
                          )}
                        </>
                      ) : <span className="muted small">—</span>
                    ) : <span className="muted small">{t.notNeeded}</span>}
                  </td>
                  <td>
                    <span className={`status s-${status}`}>{t['st_' + status]}</span>
                    {status === 'ok' && r.has_expiry && expiry[r.id] && daysAfter(expiry[r.id], deadline) <= 30 && (
                      <div className="soon">⚠ {t.soon.replace('{n}', daysAfter(expiry[r.id], deadline))}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {files.length > 0 && (
            <details className="seal">
              <summary>🤖 {t.aiTitle}</summary>
              <p className="muted small">{t.aiHelp}</p>
              <div className="seal-row">
                <input className="text key" type="password" autoComplete="off" placeholder="sk-ant-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} aria-label={t.aiKey} />
                <button className="ghost" disabled={aiBusy} onClick={askAi}>{aiBusy ? t.aiWorking : t.aiAsk}</button>
              </div>
            </details>
          )}
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
              {blocking.some((x) => x.status === 'missing') && unusedFiles.length > 0 && (
                <p className="hint-line">💡 {t.unusedHint}{' '}
                  {unusedFiles.map((f, i) => <span key={f.id}>{i ? ', ' : ''}<a href={f.url} target="_blank" rel="noreferrer">{f.name}</a></span>)}
                </p>
              )}
            </div>
          ) : (
            <p className="ok-text">✔ {t.ready}</p>
          )}
          <details className="seal">
            <summary>🖋 {t.sealTitle}</summary>
            <p className="muted small">{t.sealHelp}</p>
            <div className="seal-row">
              <label className="btn ghost-btn">
                {seal ? t.sealChange : t.sealChoose}
                <input type="file" accept="image/png" onChange={onSeal} hidden />
              </label>
              {seal && <img src={seal.url} alt="" className="seal-img" />}
              {seal && <button className="ghost" onClick={() => { setSeal(null); invalidate() }}>{t.remove}</button>}
            </div>
            {seal && (
              <div className="seal-row">
                <label>{t.sealPages}{' '}
                  <select value={sealMode} onChange={(e) => { setSealMode(e.target.value); invalidate() }}>
                    <option value="last">{t.sealLast}</option>
                    <option value="all">{t.sealAll}</option>
                    <option value="custom">{t.sealCustom}</option>
                    <option value="none">{t.sealNone}</option>
                  </select>
                </label>
                {sealMode === 'custom' && (
                  <input className="text" placeholder="3, 5-7" value={sealCustom} onChange={(e) => { setSealCustom(e.target.value); invalidate() }} />
                )}
              </div>
            )}
          </details>
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
              <VerifyPanel report={result.report} lang={lang} />
              <details className="preview" open>
                <summary>{t.previewTitle}</summary>
                <iframe className="pdf-preview" src={result.url} title={t.previewTitle} />
              </details>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
