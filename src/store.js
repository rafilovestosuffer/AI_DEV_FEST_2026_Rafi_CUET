// Save / reopen work in this browser (IndexedDB), including the PDF files themselves.
const DB = 'tender-package-builder'
const STORE = 'projects'
const KEY = 'last'

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run(mode, fn) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    tx.oncomplete = () => { db.close(); resolve(req && req.result) }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export const saveProject = (data) => run('readwrite', (s) => s.put(data, KEY))
export const loadProject = () => run('readonly', (s) => s.get(KEY))
