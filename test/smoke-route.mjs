/**
 * 路由加固回归测试（不需要跑 DSH）。
 *   node test/smoke-route.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, __setOpener } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

// ── 假的 ctx / req / res ──
const routes = new Map()
const ctx = {
  effect(fn) {
    const off = fn()
    return () => off?.()
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

function makeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(chunk) {
      out.body = chunk ? String(chunk) : ''
    },
  }
}

function makeReq({ method = 'GET', headers = {}, body = '' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req.destroy = () => {}
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

async function call(path, opts = {}) {
  const handler = routes.get(path)
  assert.ok(handler, '路由未注册：' + path)
  const res = makeRes()
  await handler(makeReq(opts), res)
  let parsed = null
  try {
    parsed = JSON.parse(res.out.body || '{}')
  } catch {
    parsed = null
  }
  return { status: res.out.status, body: parsed, headers: res.out.headers }
}

const HOST_OK = { host: '127.0.0.1:61191', 'sec-fetch-site': 'same-origin' }
const OPEN = '/dsh-custom-menu/open'
const TOKEN = '/dsh-custom-menu/token'

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(['PASS', name]))
    .catch((e) => results.push(['FAIL', name + ' — ' + e.message]))
}

// 拦截真实打开动作：成功用例不得真的弹出资源管理器
const opened = []
__setOpener(async (target) => {
  opened.push(target)
  return { ok: true, via: 'test' }
})

apply(ctx)

async function freshToken() {
  const r = await call(TOKEN, { method: 'GET', headers: HOST_OK })
  assert.equal(r.status, 200)
  assert.equal(typeof r.body.token, 'string')
  return r.body.token
}

await check('GET /open 一律 405', async () => {
  const r = await call(OPEN, { method: 'GET', headers: HOST_OK })
  assert.equal(r.status, 405)
})

await check('没有令牌 → 403', async () => {
  const r = await call(OPEN, {
    method: 'POST',
    headers: { ...HOST_OK, 'content-type': 'application/json' },
    body: JSON.stringify({ path: pluginRoot }),
  })
  assert.equal(r.status, 403)
})

await check('跨站来源（Sec-Fetch-Site: cross-site）→ 403（连令牌都不发）', async () => {
  const t = await call(TOKEN, { method: 'GET', headers: { host: HOST_OK.host, 'sec-fetch-site': 'cross-site' } })
  assert.equal(t.status, 403)
  assert.equal(t.body.token, undefined)
})

await check('Origin 指向别的站点 → 403', async () => {
  const r = await call(OPEN, {
    method: 'POST',
    headers: { ...HOST_OK, origin: 'http://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ path: pluginRoot }),
  })
  assert.equal(r.status, 403)
})

await check('Content-Type 不是 json（跨站表单那种）→ 415', async () => {
  const token = await freshToken()
  const r = await call(OPEN, {
    method: 'POST',
    headers: { ...HOST_OK, 'content-type': 'text/plain', 'x-cm-token': token },
    body: JSON.stringify({ path: pluginRoot }),
  })
  assert.equal(r.status, 415)
})

await check('令牌只能用一次', async () => {
  const token = await freshToken()
  const first = await call(OPEN, {
    method: 'POST',
    headers: { ...HOST_OK, 'content-type': 'application/json', 'x-cm-token': token },
    body: JSON.stringify({ path: pluginRoot }),
  })
  assert.equal(first.status, 200, '首次应成功，实际 ' + first.status + ' ' + JSON.stringify(first.body))
  const second = await call(OPEN, {
    method: 'POST',
    headers: { ...HOST_OK, 'content-type': 'application/json', 'x-cm-token': token },
    body: JSON.stringify({ path: pluginRoot }),
  })
  assert.equal(second.status, 403)
})

await check('打开已存在的目录 → 200 且调用一次 opener', async () => {
  const before = opened.length
  const token = await freshToken()
  const r = await call(OPEN, {
    method: 'POST',
    headers: { ...HOST_OK, 'content-type': 'application/json', 'x-cm-token': token },
    body: JSON.stringify({ path: pluginRoot }),
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(opened.length, before + 1)
})

await check('目标是文件（package.json）→ 400，不调用 opener', async () => {
  const before = opened.length
  const token = await freshToken()
  const r = await call(OPEN, {
    method: 'POST',
    headers: { ...HOST_OK, 'content-type': 'application/json', 'x-cm-token': token },
    body: JSON.stringify({ path: join(pluginRoot, 'package.json') }),
  })
  assert.equal(r.status, 400)
  assert.equal(opened.length, before)
})

await check('目标不存在 → 404', async () => {
  const token = await freshToken()
  const r = await call(OPEN, {
    method: 'POST',
    headers: { ...HOST_OK, 'content-type': 'application/json', 'x-cm-token': token },
    body: JSON.stringify({ path: join(pluginRoot, 'no-such-dir-xyz') }),
  })
  assert.equal(r.status, 404)
})

await check('相对路径 / 自定义 scheme → 400', async () => {
  for (const bad of ['relative/path', 'file:///C:/Windows', 'javascript:alert(1)', '', 'C:\\a\u0000b']) {
    const token = await freshToken()
    const r = await call(OPEN, {
      method: 'POST',
      headers: { ...HOST_OK, 'content-type': 'application/json', 'x-cm-token': token },
      body: JSON.stringify({ path: bad }),
    })
    assert.equal(r.status, 400, '应拒绝：' + JSON.stringify(bad) + ' 实际 ' + r.status)
  }
})

const failed = results.filter(([s]) => s === 'FAIL')
for (const [s, name] of results) console.log(s + '  ' + name)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
process.exit(failed.length === 0 ? 0 : 1)
