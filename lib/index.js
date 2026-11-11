/**
 * dsh-custom-menu — 宿主半边。
 *
 * 只提供一个接口：POST /dsh-custom-menu/open
 *   body: { path: "D:\\大肥鱼日记" }
 *   用系统默认方式打开文件夹/文件。
 *
 * 关键教训（2026-11-11）：export.exe 打开成功时**也会返回退出码 1**，
 * 所以不能拿退出码判断成败——这里只看「进程起没起来」，起来就算成功。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const name = 'custom-menu'
export const inject = ['webServer']

function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) req.destroy()
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

async function openTarget(target) {
  if (process.platform === 'win32') {
    const err = await launchDetached('explorer.exe', [target])
    return err ? { ok: false, via: 'explorer', error: String(err.message || err) } : { ok: true, via: 'explorer' }
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const err = await launchDetached(opener, [target])
  return err ? { ok: false, via: opener, error: String(err.message || err) } : { ok: true, via: opener }
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-custom-menu/open',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJson(req)
        const target = String(body.path ?? '').trim()
        if (!isAbsoluteLocalPath(target)) {
          json(res, 400, { ok: false, error: '只接受绝对路径（如 D:\\某文件夹）' })
          return
        }
        if (!existsSync(target)) {
          json(res, 404, { ok: false, error: '路径不存在：' + target })
          return
        }
        const r = await openTarget(target)
        json(res, r.ok ? 200 : 500, r)
      },
    }),
  )
}
