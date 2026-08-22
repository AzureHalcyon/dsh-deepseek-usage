// dsh-deepseek-usage — host half (user-owned, survives dsh upgrades).
// Node-native fetch (no shell/subprocess, credentials never cross a process
// command line). API Key lives in the DSH credentials service; the platform
// userToken lives in ~/.dsh/ds-balance.json (0600). Every route is loopback +
// same-origin guarded; balance/usage are cached with in-flight dedup.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const name = 'deepseek-usage'
export const inject = ['webServer', 'credentials', 'llm', 'settings']

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_AMOUNT_URL = 'https://platform.deepseek.com/api/v0/usage/amount'
const USAGE_COST_URL = 'https://platform.deepseek.com/api/v0/usage/cost'
const USAGE_EXPORT_URL = 'https://platform.deepseek.com/api/v0/usage/export'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const REFERER = 'https://platform.deepseek.com/usage'
const API_KEY_REF = 'DEEPSEEK_API_KEY'
const STORE_PATH = join(homedir(), '.dsh', 'ds-balance.json')

const CACHE_TTL_MS = 60_000
const ALLTIME_TTL_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 15_000
const ALLTIME_REQUEST_TIMEOUT_MS = 8_000
const ALLTIME_TOTAL_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_JSON_BODY_BYTES = 16 * 1024
const MAX_TOKEN_LENGTH = 4096
const TOKEN_VALUE_RE = /"value"\s*:\s*"([A-Za-z0-9+/=_-]{20,400})"/

const ERR = {
  MISSING_API_KEY: 'missing_api_key',
  MISSING_TOKEN: 'missing_token',
  AUTH_FAILED: 'auth_failed',
  TIMEOUT: 'timeout',
  FETCH_FAILED: 'fetch_failed',
  INVALID_RESPONSE: 'invalid_response',
  FORBIDDEN: 'forbidden',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
}
const ERR_SET = new Set(Object.values(ERR))

function codedError(code, message, status) {
  const e = new Error(message)
  e.code = code
  if (status !== undefined) e.status = status
  return e
}

function stableCode(error) {
  return typeof error?.code === 'string' && ERR_SET.has(error.code) ? error.code : ERR.FETCH_FAILED
}

// ---- loopback + same-origin guard (DNS-rebinding defense) ----
function isLoopbackRequest(req) {
  const addr = req.socket && req.socket.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  const host = req.headers && req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

// ---- durable store (userToken, 0600) ----
function emptyStore() { return { userToken: null } }

async function readStore() {
  try {
    const text = await fs.readFile(STORE_PATH, 'utf8')
    const parsed = JSON.parse(text)
    return {
      userToken: typeof parsed.userToken === 'string' && parsed.userToken !== '' ? parsed.userToken : null,
    }
  } catch {
    return emptyStore()
  }
}

async function writeStore(patch) {
  const current = await readStore()
  const next = { ...current, ...patch }
  await fs.mkdir(join(homedir(), '.dsh'), { recursive: true })
  await fs.writeFile(STORE_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try { await fs.chmod(STORE_PATH, 0o600) } catch { /* best-effort */ }
  return next
}

function maskSecret(v) {
  if (typeof v !== 'string' || v === '') return null
  if (v.length <= 10) return '****'
  return v.slice(0, 6) + '****' + v.slice(-4)
}

// Best-effort auto-read of the platform userToken from a signed-in browser
// (Chrome/Edge) localStorage, CodexBar-style: scan the Local Storage LevelDB
// log/sstable bytes for the "userToken" key and its "value":"<base64>" payload.
async function readBrowserToken() {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return null
  const roots = [
    join(localAppData, 'Google', 'Chrome', 'User Data'),
    join(localAppData, 'Microsoft', 'Edge', 'User Data'),
  ]
  for (const root of roots) {
    let profiles
    try { profiles = await fs.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const entry of profiles) {
      if (!entry.isDirectory()) continue
      const leveldbDir = join(root, entry.name, 'Local Storage', 'leveldb')
      let files
      try { files = await fs.readdir(leveldbDir) } catch { continue }
      for (const f of files) {
        if (!f.endsWith('.log') && !f.endsWith('.ldb')) continue
        let buf
        try {
          buf = await fs.readFile(join(leveldbDir, f))
        } catch { continue }
        if (buf.length > 32 * 1024 * 1024) buf = buf.subarray(0, 32 * 1024 * 1024)
        const text = buf.toString('utf8')
        let idx = 0
        while ((idx = text.indexOf('userToken', idx)) !== -1) {
          const m = text.slice(idx, idx + 2048).match(TOKEN_VALUE_RE)
          if (m && m[1]) return m[1]
          idx += 9
        }
      }
    }
  }
  return null
}

let browserTokenCache = null
let browserTokenCacheAt = 0
async function readBrowserTokenCached() {
  const now = Date.now()
  if (now - browserTokenCacheAt < 10 * 60 * 1000) return browserTokenCache
  browserTokenCache = await readBrowserToken()
  browserTokenCacheAt = now
  return browserTokenCache
}

// ---- HTTP helpers ----
async function readBodyLimited(res, maxBytes) {
  const headers = res.headers
  const contentLength = typeof headers?.get === 'function' ? headers.get('content-length') : null
  if (contentLength !== null && contentLength !== undefined && contentLength !== '') {
    const n = Number(contentLength)
    if (Number.isFinite(n) && n > maxBytes) throw codedError(ERR.INVALID_RESPONSE, '响应过大')
  }
  const text = await res.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw codedError(ERR.INVALID_RESPONSE, '响应过大')
  return text
}

async function fetchDeepSeek(url, headers, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
  let res
  try {
    const requestSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
      : AbortSignal.timeout(timeoutMs)
    res = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      redirect: 'manual',
      signal: requestSignal,
    })
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw codedError(ERR.TIMEOUT, '请求超时')
    throw codedError(ERR.FETCH_FAILED, '网络请求失败')
  }
  let text
  try {
    text = await readBodyLimited(res, MAX_RESPONSE_BYTES)
  } catch (e) {
    throw e
  }
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  return { status: res.status, data }
}

function isAuthStatus(status) { return status === 401 || status === 403 }

function envelopeAuthError(data) {
  if (!data || typeof data !== 'object') return null
  if (data.code === 40002 || data.code === 40003) return true
  const d = data.data
  if (d && typeof d === 'object' && (d.biz_code === 40002 || d.biz_code === 40003)) return true
  return false
}

// ---- usage export (CSV, per-API-key) ----
async function fetchDeepSeekBuffer(url, headers, timeoutMs = 30000) {
  let res
  try {
    res = await fetch(url, {
      headers: { accept: 'application/octet-stream', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw codedError(ERR.TIMEOUT, '请求超时')
    throw codedError(ERR.FETCH_FAILED, '网络请求失败')
  }
  if (res.status !== 200) throw codedError(ERR.FETCH_FAILED, '导出接口返回 HTTP ' + res.status, res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 64 * 1024 * 1024) throw codedError(ERR.INVALID_RESPONSE, '导出文件过大')
  return buf
}

function extractZipCsv(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) { eocd = i; break }
  }
  if (eocd < 0) throw codedError(ERR.INVALID_RESPONSE, 'zip 结构异常')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const files = {}
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compSize = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)
    const lhNameLen = buffer.readUInt16LE(localOffset + 26)
    const lhExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen
    const compressed = buffer.subarray(dataStart, dataStart + compSize)
    let data
    try {
      data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null
    } catch { data = null }
    if (data !== null && name.toLowerCase().endsWith('.csv')) files[name] = data.toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
  }
  return files
}

function parseCsvLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else current += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { result.push(current); current = '' }
      else current += ch
    }
  }
  result.push(current)
  return result
}

function parseUsageCsv(text) {
  const lines = text.trim().split('\n').map((l) => l.replace(/\r+$/, ''))
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0].replace(/^\uFEFF/, ''))
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i].trim())
    if (values.length === 0) continue
    const row = {}
    headers.forEach((h, idx) => { row[h] = idx < values.length ? values[idx] : '' })
    rows.push(row)
  }
  return rows
}

function normalizeDate(v) {
  if (!v) return ''
  if (v.length === 8 && !v.includes('-')) return v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8)
  return v
}

function summarizeUsageRows(rows, keyFilter, today) {
  const filtered = keyFilter ? rows.filter((r) => r.api_key_name === keyFilter) : rows
  let monthTokens = 0, monthRequests = 0, monthCost = 0
  let todayTokens = 0, todayRequests = 0, todayCost = 0
  const cat = { output: 0, cacheHit: 0, cacheMiss: 0 }
  const modelTokens = {}, modelCost = {}
  for (const row of filtered) {
    const type = row.type || ''
    const amount = toFloat(row.amount)
    const price = toFloat(row.price)
    const date = normalizeDate(row.utc_date)
    const isToday = date === today
    if (type === 'request_count') {
      monthRequests += amount
      if (isToday) todayRequests += amount
    } else if (type === 'output_tokens' || type === 'input_cache_hit_tokens' || type === 'input_cache_miss_tokens') {
      monthTokens += amount
      if (isToday) todayTokens += amount
      const cost = price * amount
      monthCost += cost
      if (isToday) todayCost += cost
      if (type === 'output_tokens') cat.output += amount
      else if (type === 'input_cache_hit_tokens') cat.cacheHit += amount
      else cat.cacheMiss += amount
      const m = row.model || '(unknown)'
      modelTokens[m] = (modelTokens[m] || 0) + amount
      modelCost[m] = (modelCost[m] || 0) + cost
    }
  }
  const models = Object.keys(modelTokens).map((m) => ({ model: m, tokens: modelTokens[m] || 0, cost: modelCost[m] || 0 })).sort((a, b) => b.tokens - a.tokens)
  return {
    currency: 'CNY',
    month: { tokens: monthTokens, cost: monthCost, requests: monthRequests },
    today: { tokens: todayTokens, cost: todayCost, requests: todayRequests },
    models,
    breakdown: { cacheHit: cat.cacheHit, cacheMiss: cat.cacheMiss, output: cat.output },
    fetchedAt: Date.now(),
  }
}

// Sum every row of a window CSV (used for "today" = Beijing-time export window).
function summarizeWindowRows(rows, keyFilter) {
  const filtered = keyFilter ? rows.filter((r) => r.api_key_name === keyFilter) : rows
  let tokens = 0, requests = 0, cost = 0
  for (const row of filtered) {
    const type = row.type || ''
    const amount = toFloat(row.amount)
    if (type === 'request_count') requests += amount
    else if (type === 'output_tokens' || type === 'input_cache_hit_tokens' || type === 'input_cache_miss_tokens') {
      tokens += amount
      cost += toFloat(row.price) * amount
    }
  }
  return { tokens, cost, requests }
}

async function fetchUsageExportWindow(token, start, end) {
  if (!token) throw codedError(ERR.MISSING_TOKEN, '未配置 userToken')
  const url = USAGE_EXPORT_URL + '?start=' + start + '&end=' + end + '&tz=0'
  const headers = { authorization: 'Bearer ' + token, 'user-agent': UA, referer: REFERER }
  const buf = await fetchDeepSeekBuffer(url, headers)
  const files = extractZipCsv(buf)
  let csvText = ''
  for (const name of Object.keys(files)) {
    if (name.toLowerCase().includes('amount')) { csvText = files[name]; break }
  }
  if (!csvText) throw codedError(ERR.INVALID_RESPONSE, '导出 zip 中未找到 amount CSV')
  const rows = parseUsageCsv(csvText)
  const keys = []
  const seen = new Set()
  for (const row of rows) {
    const k = row.api_key_name
    if (k && !seen.has(k)) { seen.add(k); keys.push(k) }
  }
  return { rows, keys }
}

async function fetchUsageExport(token) {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const start = Math.floor(Date.UTC(year, month - 1, 1) / 1000)
  const end = Math.floor(Date.UTC(year, month, 1) / 1000)
  return fetchUsageExportWindow(token, start, end)
}

// "今日"（北京时间）：平台 usage 日数据按 UTC 切分，从日聚合无法精确得到本地时区的
// "今天"（如 GMT+8 的 0:00–8:00 落在 UTC 昨天）。改用导出接口的本地时区窗口：
// [本地今天 0:00 → 下一整点]。接口要求 start/end 为整点，且窗口 ≤ 24h 或对齐 UTC 日；
// 该窗口长度恒为 1–24h，始终满足。
async function fetchTodayUsage(token) {
  const now = new Date()
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime() / 1000)
  // Convert the rounded epoch-hour back to epoch seconds. Dividing by 1000
  // here would shrink the timestamp by three orders of magnitude, causing the
  // fallback below to query only 00:00–01:00 and making today's values appear 0.
  const nextHourSec = Math.ceil(now.getTime() / 3600000) * 3600
  const end = Math.max(nextHourSec, start + 3600)
  return fetchUsageExportWindow(token, start, end)
}

// ---- balance ----
async function fetchBalance(apiKey) {
  if (!apiKey) throw codedError(ERR.MISSING_API_KEY, '未配置 DeepSeek API Key')
  const { status, data } = await fetchDeepSeek(BALANCE_URL, { authorization: 'Bearer ' + apiKey })
  if (isAuthStatus(status)) throw codedError(ERR.AUTH_FAILED, 'API Key 无效', status)
  if (status !== 200 || !data || typeof data !== 'object' || !Array.isArray(data.balance_infos)) {
    throw codedError(ERR.INVALID_RESPONSE, '余额接口返回异常', status)
  }
  return { is_available: data.is_available === true, balance_infos: data.balance_infos, fetchedAt: Date.now() }
}

// ---- usage ----
function toInt(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n }
function toFloat(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n }
function todayString() {
  // 平台的 usage/amount、usage/cost 按 UTC 切分每日数据（days[].date，CSV 列为 utc_date），
  // "今日"必须用 UTC 日期匹配；否则在本地时区领先 UTC 的时段（如 GMT+8 的 0:00–8:00），
  // 本地"今天"的消费会被记在 UTC 的"昨天"，导致今日显示 0。
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
}

function summarizeUsage(amountData, costData) {
  const biz = (amountData && amountData.data && amountData.data.biz_data) || {}
  const costBizRaw = costData && costData.data && costData.data.biz_data
  const costItem = (Array.isArray(costBizRaw) && costBizRaw[0]) || {}
  const currency = costItem.currency || 'CNY'

  const cat = { PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0, RESPONSE_TOKEN: 0 }
  let monthTokens = 0
  let monthRequests = 0
  const modelTokens = {}
  ;(biz.total || []).forEach((m) => {
    let mt = 0
    ;(m.usage || []).forEach((u) => {
      const t = u.type || ''
      const n = toInt(u.amount)
      if (t === 'REQUEST') monthRequests += n
      else { mt += n; monthTokens += n; if (cat[t] !== undefined) cat[t] += n }
    })
    if (m.model) modelTokens[m.model] = (modelTokens[m.model] || 0) + mt
  })

  let monthCost = 0
  ;(costItem.total || []).forEach((m) => {
    ;(m.usage || []).forEach((u) => {
      if ((u.type || '') !== 'REQUEST') monthCost += toFloat(u.amount)
    })
  })

  const dayTokens = {}
  const dayRequests = {}
  const dayCost = {}
  ;(costItem.days || []).forEach((d) => {
    let c = 0
    ;(d.data || []).forEach((m) => { (m.usage || []).forEach((u) => { if ((u.type || '') !== 'REQUEST') c += toFloat(u.amount) }) })
    if (d.date) dayCost[d.date] = c
  })
  ;(biz.days || []).forEach((d) => {
    let tk = 0
    let rq = 0
    ;(d.data || []).forEach((m) => { (m.usage || []).forEach((u) => { const t = u.type || ''; const n = toInt(u.amount); if (t === 'REQUEST') rq += n; else tk += n }) })
    if (d.date) { dayTokens[d.date] = tk; dayRequests[d.date] = rq }
  })

  const modelCost = {}
  ;(costItem.total || []).forEach((m) => {
    let c = 0
    ;(m.usage || []).forEach((u) => { if ((u.type || '') !== 'REQUEST') c += toFloat(u.amount) })
    if (m.model) modelCost[m.model] = (modelCost[m.model] || 0) + c
  })

  const t = todayString()
  const models = Object.keys(modelTokens).map((model) => ({
    model,
    tokens: modelTokens[model] || 0,
    cost: modelCost[model] || 0,
  })).sort((a, b) => b.tokens - a.tokens)

  return {
    currency,
    month: { tokens: monthTokens, cost: monthCost, requests: monthRequests },
    today: { tokens: dayTokens[t] || 0, cost: dayCost[t] || 0, requests: dayRequests[t] || 0 },
    models,
    breakdown: { cacheHit: cat.PROMPT_CACHE_HIT_TOKEN, cacheMiss: cat.PROMPT_CACHE_MISS_TOKEN, output: cat.RESPONSE_TOKEN },
    fetchedAt: Date.now(),
  }
}

async function fetchMonthlyUsage(token) {
  if (!token) throw codedError(ERR.MISSING_TOKEN, '未配置 userToken')
  const now = new Date()
  const month = now.getMonth() + 1
  const year = now.getFullYear()
  const headers = { authorization: 'Bearer ' + token, 'user-agent': UA, referer: REFERER }
  const [amountRes, costRes] = await Promise.all([
    fetchDeepSeek(USAGE_AMOUNT_URL + '?month=' + month + '&year=' + year, headers),
    fetchDeepSeek(USAGE_COST_URL + '?month=' + month + '&year=' + year, headers),
  ])
  if (isAuthStatus(amountRes.status) || isAuthStatus(costRes.status) || envelopeAuthError(amountRes.data) || envelopeAuthError(costRes.data)) {
    throw codedError(ERR.AUTH_FAILED, 'userToken 无效或已过期')
  }
  if (amountRes.status !== 200 || costRes.status !== 200 || !amountRes.data || !costRes.data) {
    throw codedError(ERR.INVALID_RESPONSE, '用量接口返回异常')
  }
  return summarizeUsage(amountRes.data, costRes.data)
}

function monthCostOf(data) {
  const biz = data && data.data && data.data.biz_data
  const item = (Array.isArray(biz) && biz[0]) || {}
  let total = 0
  ;(item.total || []).forEach((m) => {
    ;(m.usage || []).forEach((u) => { if ((u.type || '') !== 'REQUEST') total += toFloat(u.amount) })
  })
  return total
}

async function fetchAllTimeTotal(token, signal) {
  if (!token) throw codedError(ERR.MISSING_TOKEN, '未配置 userToken')
  const now = new Date()
  let year = now.getFullYear()
  let month = now.getMonth() + 1
  let total = 0
  let zeroStreak = 0
  for (let i = 0; i < 48; i++) {
    const url = USAGE_COST_URL + '?month=' + month + '&year=' + year
    const { status, data } = await fetchDeepSeek(url, { authorization: 'Bearer ' + token, 'user-agent': UA, referer: REFERER }, ALLTIME_REQUEST_TIMEOUT_MS, signal)
    if (isAuthStatus(status) || envelopeAuthError(data)) throw codedError(ERR.AUTH_FAILED, 'userToken 无效或已过期', status)
    if (status !== 200 || !data) throw codedError(ERR.FETCH_FAILED, '消费接口返回 HTTP ' + status, status)
    const mc = monthCostOf(data)
    total += mc
    if (mc === 0) { zeroStreak += 1; if (zeroStreak >= 3) break } else zeroStreak = 0
    month -= 1
    if (month === 0) { month = 12; year -= 1 }
  }
  return total
}

// ---- cached fetcher (TTL + in-flight dedup + stale fallback on failure) ----
function createCachedFetcher(fetcher, ttlMs) {
  let cache = null
  let inflight = null
  function run() {
    const now = Date.now()
    if (cache && now - cache.at < ttlMs) return Promise.resolve({ payload: cache.payload, cached: true, stale: false })
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const payload = await fetcher()
        cache = { payload, at: Date.now() }
        return { payload, cached: false, stale: false }
      } catch (e) {
        if (cache) return { payload: cache.payload, cached: true, stale: true, staleError: String(e?.message || e) }
        throw e
      } finally {
        inflight = null
      }
    })()
    return inflight
  }
  function clear() { cache = null }
  return { run, clear }
}

// ---- routes ----
export function apply(ctx) {
  function providerEntries() {
    try {
      const activeIds = new Set((ctx.llm.listProviders() || []).map((p) => p && p.id).filter(Boolean))
      return (ctx.llm.listConfigurableProviders() || []).filter((p) => activeIds.has(p.provider))
    } catch { return [] }
  }

  function refForProvider(provider) {
    const entry = providerEntries().find((p) => p.provider === provider)
    if (!entry) return API_KEY_REF
    let ref = API_KEY_REF
    try {
      const doc = ctx.settings.get(entry.settingsNs)
      let node = doc
      for (const key of entry.settingsPath || []) {
        if (node && typeof node === 'object') node = node[key]
        else { node = undefined; break }
      }
      if (node && typeof node.apiKeyEnv === 'string' && node.apiKeyEnv.trim()) ref = node.apiKeyEnv.trim()
    } catch { /* keep default */ }
    return ref
  }

  async function resolveApiKey() {
    const ref = refForProvider('deepseek-official')
    try {
      const cred = await ctx.credentials.resolve(ref)
      const v = cred && typeof cred.value === 'string' ? cred.value.trim() : ''
      return v || null
    } catch { return null }
  }

  async function resolveToken() {
    const auto = await readBrowserTokenCached()
    if (auto) return { token: auto, source: 'auto' }
    const store = await readStore()
    if (store.userToken) return { token: store.userToken, source: 'manual' }
    return { token: null, source: null }
  }

  const balanceFetcher = createCachedFetcher(async () => fetchBalance(await resolveApiKey()), CACHE_TTL_MS)
  const usageFetcher = createCachedFetcher(async () => fetchMonthlyUsage((await resolveToken()).token), CACHE_TTL_MS)
  const allTimeFetcher = createCachedFetcher(async () => {
    const token = (await resolveToken()).token
    return fetchAllTimeTotal(token, AbortSignal.timeout(ALLTIME_TOTAL_TIMEOUT_MS))
  }, ALLTIME_TTL_MS)
  const usageExportFetcher = createCachedFetcher(async () => fetchUsageExport((await resolveToken()).token), CACHE_TTL_MS)
  const todayFetcher = createCachedFetcher(async () => fetchTodayUsage((await resolveToken()).token), CACHE_TTL_MS)

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  function guard(req, res, method) {
    if (!isLoopbackRequest(req)) { json(res, 403, { ok: false, code: ERR.FORBIDDEN, message: 'forbidden' }); return false }
    if (req.method !== method) { json(res, 405, { ok: false, code: ERR.METHOD_NOT_ALLOWED, message: 'method not allowed' }); return false }
    return true
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) return null
      chunks.push(chunk)
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch { return null }
  }

  const routes = [
    {
      kind: 'exact',
      path: '/deepseek-usage/status',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const apiKey = await resolveApiKey()
        const resolvedToken = await resolveToken()
        json(res, 200, {
          ok: true,
          hasKey: !!apiKey,
          maskedKey: maskSecret(apiKey),
          hasToken: !!resolvedToken.token,
          maskedToken: maskSecret(resolvedToken.token),
          tokenSource: resolvedToken.source,
        })
      },
    },
    {
      kind: 'exact',
      path: '/deepseek-usage/balance',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const result = await balanceFetcher.run()
          json(res, 200, { ok: true, data: result.payload, cached: result.cached, stale: result.stale })
        } catch (e) {
          const code = stableCode(e)
          const status = typeof e.status === 'number' ? e.status : 502
          console.error('[deepseek-usage] balance failed:', status === 502 ? code : { code, status })
          json(res, status, { ok: false, code })
        }
      },
    },
    {
      kind: 'exact',
      path: '/deepseek-usage/usage',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const keyFilter = (() => {
            try { return new URL(req.url, 'http://x').searchParams.get('key') || null } catch { return null }
          })()
          let payload
          if (keyFilter) {
            const exportResult = await usageExportFetcher.run()
            payload = { ...summarizeUsageRows(exportResult.payload.rows, keyFilter, todayString()), cached: exportResult.cached, stale: exportResult.stale }
          } else {
            const usageResult = await usageFetcher.run()
            payload = { ...usageResult.payload, cached: usageResult.cached, stale: usageResult.stale }
          }
          // "今日"改用导出接口的北京时间窗口（usage 日数据按 UTC 切分，见 fetchTodayUsage）。
          // 失败时回退月数据里的 UTC 今日口径。
          try {
            const todayResult = await todayFetcher.run()
            payload.today = summarizeWindowRows(todayResult.payload.rows, keyFilter)
            payload.todaySource = 'export'
          } catch (e) {
            payload.todaySource = 'month'
            console.error('[deepseek-usage] today export failed:', stableCode(e))
          }
          try {
            const totalResult = await allTimeFetcher.run()
            payload.totalCost = totalResult.payload
          } catch (e) {
            payload.totalCost = null
          }
          json(res, 200, { ok: true, data: payload })
        } catch (e) {
          const code = stableCode(e)
          const status = typeof e.status === 'number' ? e.status : 502
          console.error('[deepseek-usage] usage failed:', status === 502 ? code : { code, status })
          json(res, status, { ok: false, code })
        }
      },
    },
    {
      kind: 'exact',
      path: '/deepseek-usage/keys',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const exportResult = await usageExportFetcher.run()
          json(res, 200, { ok: true, keys: exportResult.payload.keys, cached: exportResult.cached, stale: exportResult.stale })
        } catch (e) {
          const code = stableCode(e)
          const status = typeof e.status === 'number' ? e.status : 502
          console.error('[deepseek-usage] keys failed:', status === 502 ? code : { code, status })
          json(res, status, { ok: false, code })
        }
      },
    },
    {
      kind: 'exact',
      path: '/deepseek-usage/token',
      handler: async (req, res) => {
        if (req.method === 'PUT') {
          if (!guard(req, res, 'PUT')) return
          const body = await readJsonBody(req)
          const token = body && typeof body.token === 'string' ? body.token.trim() : ''
          if (!token) { json(res, 400, { ok: false, code: ERR.INVALID_RESPONSE, message: 'token 不能为空' }); return }
          if (token.length > MAX_TOKEN_LENGTH) { json(res, 400, { ok: false, code: ERR.INVALID_RESPONSE, message: 'token 过长' }); return }
          try {
            const store = await writeStore({ userToken: token })
            usageFetcher.clear()
            allTimeFetcher.clear()
            usageExportFetcher.clear()
            todayFetcher.clear()
            json(res, 200, { ok: true, hasToken: !!store.userToken, maskedToken: maskSecret(store.userToken) })
          } catch (e) {
            console.error('[deepseek-usage] set token failed:', stableCode(e))
            json(res, 502, { ok: false, code: ERR.FETCH_FAILED })
          }
          return
        }
        if (req.method === 'DELETE') {
          if (!guard(req, res, 'DELETE')) return
          try {
            const store = await writeStore({ userToken: null })
            usageFetcher.clear()
            allTimeFetcher.clear()
            usageExportFetcher.clear()
            todayFetcher.clear()
            json(res, 200, { ok: true, hasToken: !!store.userToken })
          } catch (e) {
            json(res, 502, { ok: false, code: ERR.FETCH_FAILED })
          }
          return
        }
        json(res, 405, { ok: false, code: ERR.METHOD_NOT_ALLOWED })
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => { for (const d of disposers) d() }
  }, 'deepseek-usage: routes')
}
