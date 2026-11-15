/**
 * dsh-custom-menu — 宿主半边。
 *
 * 两个接口：
 *   GET  /dsh-custom-menu/token  一次性令牌（同源可读，跨源读不到正文）
 *   POST /dsh-custom-menu/open   body: { path: "D:\\大肥鱼日记" }，需带 X-CM-Token
 *
 * 安全约束（v0.9.2 加固，起因见市场条目里维护者追加的那句提示）：
 *   1. 一次性令牌：跨站页面拿不到正文，也就伪造不出请求；
 *   2. 来源校验：Sec-Fetch-Site 显式为 cross-site 直接拒绝；Origin 若是 http(s) 必须与 Host 一致；
 *   3. Content-Type 必须是 application/json（跨站表单提交发不出来）；
 *   4. 只打开**目录**，文件一律拒——堵掉「把本地已存在的文件丢给默认程序」这条路；
 *   5. 路径必须是绝对本地路径，参数以数组传给 spawn，不经过 shell。
 *
 * 关键教训（2026-11-11）：explorer.exe 打开成功时**也会返回退出码 1**，
 * 所以不能拿退出码判断成败——这里只看「进程起没起来」，起来就算成功。
 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const name = 'custom-menu'
export const inject = ['webServer']

const TOKEN_HEADER = 'x-cm-token'
const TOKEN_TTL_MS = 60_000
const MAX_TOKENS = 16
const MAX_BODY = 16 * 1024

/** 待用的一次性令牌：token -> 过期时间戳（毫秒） */
const pending = new Map()

function issueToken() {
  pruneTokens()
  const t = randomBytes(32).toString('hex')
  pending.set(t, Date.now() + TOKEN_TTL_MS)
  if (pending.size > MAX_TOKENS) {
    const oldest = [...pending.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) pending.delete(oldest[0])
  }
  return t
}

function pruneTokens() {
  const now = Date.now()
  for (const [t, exp] of pending) if (exp <= now) pending.delete(t)
}

function consumeToken(value) {
  pruneTokens()
  if (typeof value !== 'string' || value.length === 0) return false
  let matched = null
  for (const t of pending.keys()) {
    if (t.length === value.length && timingSafeEqual(Buffer.from(t), Buffer.from(value))) matched = t
  }
  if (!matched) return false
  pending.delete(matched)
  return true
}

/**
 * 同源判定。
 * - Sec-Fetch-Site 显式为 cross-site / same-site 一律拒；
 * - Origin 存在时，若是 http(s) 源，host 必须与 Host 头一致；
 * - 其余情况（Electron 自定义协议等可能不带 Origin）靠令牌兜底。
 */
function sameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (origin) {
    if (origin === 'null') return false
    try {
      const u = new URL(origin)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const host = String(req.headers.host || '')
        if (host && u.host !== host) return false
      }
    } catch {
      return false
    }
  }
  return true
}

function isJsonRequest(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase()
  return ct.startsWith('application/json')
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function isAbsoluteLocalPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false
  if (p.includes('\u0000')) return false
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (/^\\\\[^\\]+\\/.test(p)) return true
  return false
}

/** 只接受「存在且是目录」的路径；返回 { ok } 或 { ok:false, status, error } */
function inspectDirectory(target) {
  let st
  try {
    st = statSync(target, { throwIfNoEntry: false })
  } catch {
    return { ok: false, status: 403, error: '无法读取该路径' }
  }
  if (!st) return { ok: false, status: 404, error: '路径不存在：' + target }
  if (!st.isDirectory()) return { ok: false, status: 400, error: '只支持文件夹，不支持直接打开文件：' + target }
  return { ok: true }
}

function launchDetached(file, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', (err) => resolve(err))
      child.unref()
      // 起得来就算成功：不等退出码（explorer 成功也返回 1）
      setTimeout(() => resolve(null), 60)
    } catch (e) {
      resolve(e)
    }
  })
}

let opener = async function openTarget(target) {
  if (process.platform === 'win32') {
    const err = await launchDetached('explorer.exe', [target])
    return err ? { ok: false, via: 'explorer', error: String(err.message || err) } : { ok: true, via: 'explorer' }
  }
  const bin = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const err = await launchDetached(bin, [target])
  return err ? { ok: false, via: bin, error: String(err.message || err) } : { ok: true, via: bin }
}

/** 仅供测试替换真实打开动作，运行时不会被调用 */
export function __setOpener(fn) {
  opener = fn
}

export function apply(ctx) {
  ctx.effect(() => {
    const offToken = ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-custom-menu/token',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!sameOrigin(req)) {
          json(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        json(res, 200, { ok: true, token: issueToken(), ttl: TOKEN_TTL_MS })
      },
    })

    const offOpen = ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-custom-menu/open',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!sameOrigin(req)) {
          json(res, 403, { ok: false, error: 'forbidden：来源不可信' })
          return
        }
        if (!isJsonRequest(req)) {
          json(res, 415, { ok: false, error: '需要 content-type: application/json' })
          return
        }
        if (!consumeToken(req.headers[TOKEN_HEADER])) {
          json(res, 403, { ok: false, error: '令牌缺失或已失效，请重新获取' })
          return
        }
        const body = await readJson(req)
        const target = String(body.path ?? '').trim()
        if (!isAbsoluteLocalPath(target)) {
          json(res, 400, { ok: false, error: '只接受绝对路径（如 D:\\某文件夹）' })
          return
        }
        const check = inspectDirectory(target)
        if (!check.ok) {
          json(res, check.status, { ok: false, error: check.error })
          return
        }
        const r = await opener(target)
        json(res, r.ok ? 200 : 500, r)
      },
    })

    return () => {
      offToken?.()
      offOpen?.()
    }
  })
}
