# Tender Package Builder — AI DevFest 2026 (Vibe Coding)

**Participant:** Rafiur Rahman (CUET) · **Registration no.:** `<REG_NO>`
**Live app:** https://rafilovestosuffer.github.io/AI_DEV_FEST_2026_Rafi_CUET/
**Repository:** https://github.com/rafilovestosuffer/AI_DEV_FEST_2026_Rafi_CUET

A frontend-only web app that turns a set of PDF files into **one complete, checked, correctly ordered tender package** (`<tender_id>_Package.pdf`). It works fully in Bangla and English. All processing happens inside the browser: no server, no database, and no file ever leaves the computer.

## How to use (for office staff)
1. **Open `requirements.json`.** The tender details and the required documents appear, sorted by `order`.
2. **Upload the PDF files.** Select many at once or drag and drop them. Each file shows a page-1 thumbnail, its page count and its size; click a file to open it. Non-PDF, damaged and password-protected files are rejected with a clear message. Identical files are marked **Duplicate**.
3. **Match each document to a file.** Use the dropdown, or click **Suggest matches from file names**. Enter the expiry date where asked; the app shows any date it found in the file as a one-click hint.
4. **Make the package.** Generate stays disabled, with the reasons listed, until nothing is blocking. Then click **Generate package** → **Download**.

Use the **বাংলা / English** button (top right) to switch the whole app between languages at any time.

## Run locally
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```
Deployment: GitHub Pages through `.github/workflows/deploy.yml`, run on every push to `main`.

## Main tasks (problem statement §4–6)
| # | Task | Status |
|---|---|---|
| 4.1 | Load `requirements.json`, show the tender details and the documents sorted by `order` (validated; a clear error for a bad file) | ✅ |
| 4.2 | Multi-file upload, file name + page count, non-PDF rejected with a message, remove any file | ✅ |
| 4.3 | One file ↔ one document; change or undo at any time (a file used elsewhere is disabled) | ✅ |
| 4.4 | Expiry date input for `has_expiry` documents that have a file (cleared when the file changes) | ✅ |
| 4.5 | Status per document, updated instantly: Missing / Expiry date needed / Expired / Not provided / OK | ✅ |
| 4.6 | Duplicates found by SHA-256 of the content (any file name); a duplicate cannot be matched to a different document | ✅ |
| 4.7 | Generate disabled while anything is blocking, with the reasons listed | ✅ |
| 4.8 | Download as `<tender_id>_Package.pdf` | ✅ |
| 4.9 | Whole UI in Bangla and English; document names from `title_bn` / `title_en` | ✅ |
| 6.1 | English cover: tender ID, title, procuring entity, bidder, deadline, date made, documents in order | ✅ |
| 6.2 | Documents sorted by `order`, all pages in their original order, optional documents with no file skipped | ✅ |
| 6.3–6.4 | Footer `<tender_id> \| Page X of Y` on every page including the cover. Each source page is scaled into the area above a reserved 30 pt footer band, so the footer never covers content. Rotated and landscape pages are handled. | ✅ |

Status rules follow §5 exactly. Dates are compared as `YYYY-MM-DD` strings (no time-zone errors). Expiry **on** the deadline day = OK; any earlier date = Expired.

## Bonus tasks
- ✅ **Index page** after the cover, with the start page of each document.
- ✅ **Bangla text shown correctly in the PDF** (index page). Bangla titles are drawn by the browser's own text engine and embedded as images, so conjuncts such as ট্রেড and স্বাক্ষরিত render correctly. pdf-lib cannot shape Bengali.
- ✅ **Seal / signature:** upload a PNG and place it on the last page of each document, on every document page, or on chosen pages (e.g. `3, 5-7`).
- ✅ **Export checklist as CSV** (document, file name, pages, expiry date, status; UTF-8 with BOM so Excel opens it).
- ✅ **Save and reopen work:** the requirements, the PDF files, the matches and the expiry dates are kept in this browser (IndexedDB).
- ✅ **Auto-match:** scores file names (plus first-page text for badly named files), picks the newest year when two files tie, and never uses duplicates.
- ✅ **Bad files handled safely:** non-PDF (header check, not only the extension), damaged and password-protected PDFs, and the 30-file / 50 MB limits each get a clear message.
- ✅ **AI help (optional):** the user types their own Anthropic API key, which stays in memory and is never saved. On click, only the unused files are sent (text, or a picture of page 1 for scanned files) to suggest matches. Everything else works without AI. No key is in this repository or the site.
- ➕ **Package self-check:** after generating, the app re-opens the finished PDF and checks §6 on the real file: page count = cover + index + all document pages, the footer on every page, page 1 is the cover, each document starts on its page in tender order (compared with the original file), and no document text sits under the footer. The result is shown as ✔/✖ in Bangla or English.
- ➕ **Works offline:** an installable web app with a service worker. After one visit it runs with no internet, which suits offices with unreliable connections. Only the app's own files are cached, never tender documents.
- ➕ **Package preview in the page:** check the cover, index and page numbers before downloading.
- ➕ **Readiness bar** ("Required documents ready: 7 / 8") and an **early expiry warning** when a document is valid 30 days or less after the deadline. The warning does not block; the §5 rules stay exactly as written.
- ➕ Extra help for non-technical users: expiry dates found in the PDF text are offered as hints (never filled in automatically), scanned files carry a "scanned image" badge, unused files are listed when a document is missing, status count chips, and the chosen language is remembered.

## Sample pack: problems found and resolved
| File | Problem | How the app handles it |
|---|---|---|
| `company_logo.png` | Not a PDF | Rejected with a message |
| `experience_cert (1).pdf` | Same content as `experience_cert.pdf` | Marked Duplicate; cannot be used for another document |
| `trade_license_2025.pdf` | Expired 2025-06-30, before the 2026-10-20 deadline | Shows **Expired** and blocks; `trade_license_2026.pdf` (valid to 2027-06-30) is used |
| `scan_0042.pdf` | Image-only scan whose name gives no clue; it is the **Signed Declaration** | Thumbnail + "scanned image" badge + unused-file hint, matched by hand (or by AI help) |
| `01_financial…`, `02_technical…`, `03_tin…`, `04_vat…` | Number prefixes in the file names do not follow the tender order | Order always comes from `requirements.json` |
| Audited Financial Statement, Manufacturer's Authorization | No file (optional) | **Not provided**, does not block |

Result: [`output/T-2026-0417_Package.pdf`](output/T-2026-0417_Package.pdf), 17 pages = cover + index + 15 document pages, generated on the live site.

## Screenshots
| | |
|---|---|
| Upload: non-PDF rejected, duplicates flagged, thumbnails | [`01_upload_rejects_duplicates.png`](screenshots/01_upload_rejects_duplicates.png) |
| **Document statuses** with problems (Expired, Expiry date needed, Missing, Not provided) and Generate blocked with reasons | [`02_statuses_problems_en.png`](screenshots/02_statuses_problems_en.png) |
| All fixed: every status OK, package ready, preview | [`03_all_ok_package_ready_en.png`](screenshots/03_all_ok_package_ready_en.png) |
| The same screen in Bangla | [`04_all_ok_bangla.png`](screenshots/04_all_ok_bangla.png) |
| Offline mode | [`05_offline_mode.png`](screenshots/05_offline_mode.png) |

## Known problems / limits
- The cover page is English only, as the rules require; Bangla appears on the index page.
- To make room for the footer, each original page is scaled to about 96 %. Nothing is cut off or covered.
- Links and form fields inside the source PDFs are not kept (each page is re-placed as embedded vector content, which keeps text and images sharp but drops interactive parts).
- Expiry hints only work for PDFs with a text layer; scanned documents need the date typed in.
- AI help needs the user's own Anthropic API key and an internet connection. It was not tested against the live API during the contest. If it fails, the app shows the error and keeps working.
- Saved work is stored only in this browser on this computer.

## Tech
React + Vite · [pdf-lib](https://pdf-lib.js.org/) (merge, cover, index, footer, seal) · [pdf.js](https://mozilla.github.io/pdf.js/) (thumbnails, text, expiry hints) · Web Crypto SHA-256 (duplicates) · IndexedDB (save/reopen) · GitHub Pages.

## AI tools used
- **Claude Code** (Anthropic): planning, sample-pack analysis, code generation, testing in the browser, the README.
- Every commit message records the prompt that was used.

**Most useful prompt:** *"we are in a highly competitive vibe coding competition … contenue, and make deep research and improve and compelte everything so high intime"*. After this prompt the AI first worked through the sample pack to find the hidden problems (expired licence, duplicate, non-PDF, image-only declaration, misleading number prefixes), then built and tested each rule against them.
