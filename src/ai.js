// Optional AI help: suggest which requirement each unmatched file belongs to.
// Uses the user's own Anthropic API key, typed into the app and kept only in memory.
// Nothing is sent unless the user clicks the button. The app works fully without this.

const MODEL = 'claude-sonnet-5-5'

export async function aiSuggest({ apiKey, requirements, files }) {
  const content = [
    {
      type: 'text',
      text:
        'You help office staff build a tender submission package. Match each uploaded file to at most one required document. ' +
        'Use only the evidence given (file name, extracted text or page image). If unsure, leave the file out.\n\n' +
        'Required documents still without a file:\n' +
        requirements.map((r) => `- ${r.id}: ${r.title_en}`).join('\n') +
        '\n\nFiles follow. Answer ONLY with JSON: {"matches":[{"file":"<exact file name>","req":"<requirement id>","reason":"<max 12 words>"}]}',
    },
  ]
  for (const f of files) {
    if (f.image) {
      content.push({ type: 'text', text: `FILE "${f.name}" (scanned page image, first page):` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.image } })
    } else {
      content.push({ type: 'text', text: `FILE "${f.name}" first-page text:\n${(f.text || '').slice(0, 1200)}` })
    }
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content }] }),
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { msg = (await res.json()).error?.message || msg } catch { /* keep status */ }
    throw new Error(msg)
  }
  const data = await res.json()
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  const parsed = JSON.parse(json)
  return Array.isArray(parsed.matches) ? parsed.matches : []
}
