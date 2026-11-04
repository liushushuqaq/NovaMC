/**
 * 更新功能的 IPC 层：检测 / 下载 / 安装（替换自己）。
 *
 * 便携版 exe 运行时无法覆盖自己，标准做法是：
 * 1. 下载新 exe 到 <exe 同目录>/NovaMC-<新版本>.exe.new
 * 2. 校验通过后，用户点「重启更新」时写一个极小的替换脚本
 * 3. app.quit() → 脚本等 1 秒 → 把 .new 覆盖成正式 exe → 重新拉起新版本
 */
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Updater, type UpdateInfo } from '../core/updater'
import type { AppContext } from './context'
import type { Result } from '../core/types'
import { toResultError } from '../core/errors'

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (e) {
    return toResultError(e) as Result<T>
  }
}

/** 更新下载/替换过程中的进度广播给渲染进程 */
function broadcast(payload: UpdateProgress): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:progress', payload)
}

interface UpdateProgress {
  phase: 'downloading' | 'downloaded' | 'installing' | 'error'
  doneBytes: number
  totalBytes: number
  message?: string
}

/** 当前待安装的新版本信息与下载好的临时文件 */
let pendingUpdate: { info: UpdateInfo; filePath: string } | null = null

/** 更新时是否是可执行文件（.exe） */
function isWindows(): boolean {
  return process.platform === 'win32'
}

/** 下载新 exe 到应用目录，返回可用的临时文件路径 */
function downloadDest(info: UpdateInfo): string {
  const exePath = process.execPath
  const dir = path.dirname(exePath)
  return path.join(dir, `NovaMC-${info.version}.exe.new`)
}

export function registerUpdateIpc(ctx: AppContext): void {
  const updater = new Updater(ctx.http)

  /* ---------------- 检测更新 ---------------- */
  ipcMain.handle('update:check', async () =>
    guard(async () => {
      const current = app.getVersion()
      const res = await updater.check(current)
      return res
    })
  )

  /* ---------------- 下载更新 ---------------- */
  ipcMain.handle('update:download', async () =>
    guard(async () => {
      const current = app.getVersion()
      const check = await updater.check(current)
      if (!check.hasUpdate || !check.latest) {
        return { hasUpdate: false, latest: null as UpdateInfo | null, downloaded: false }
      }
      const dest = downloadDest(check.latest)
      broadcast({ phase: 'downloading', doneBytes: 0, totalBytes: check.latest.size })
      await updater.download(check.latest, dest, (done, total) =>
        broadcast({ phase: 'downloading', doneBytes: done, totalBytes: total })
      )
      pendingUpdate = { info: check.latest, filePath: dest }
      broadcast({ phase: 'downloaded', doneBytes: check.latest.size, totalBytes: check.latest.size })
      return { hasUpdate: true, latest: check.latest, downloaded: true }
    })
  )

  /* ---------------- 安装更新（替换自己并重启） ---------------- */
  ipcMain.handle('update:install', async () =>
    guard(async () => {
      if (!pendingUpdate) return { installed: false }
      if (!isWindows()) {
        // 非 Windows 暂时只弹下载链接
        void shell.openExternal(pendingUpdate.info.url)
        return { installed: false }
      }
      installAndRestart(pendingUpdate.info, pendingUpdate.filePath)
      return { installed: true }
    })
  )

  /* ---------------- 打开更新说明 / 下载页 ---------------- */
  ipcMain.handle('update:openReleases', async () =>
    guard(async () => {
      await shell.openExternal('https://github.com/liushushuqaq/NovaMC-Updates/releases')
      return null
    })
  )

  /* ---------------- 打开开源源码仓库 ---------------- */
  ipcMain.handle('update:openSource', async () =>
    guard(async () => {
      await shell.openExternal('https://github.com/liushushuqaq/NovaMC')
      return null
    })
  )

  /* ---------------- 取消下载并清理 ---------------- */
  ipcMain.handle('update:cancel', async () =>
    guard(async () => {
      if (pendingUpdate?.filePath) {
        try {
          fs.rmSync(pendingUpdate.filePath, { force: true })
        } catch {
          /* ignore */
        }
      }
      pendingUpdate = null
      return null
    })
  )
}

/**
 * 替换自己：写一个 bat 脚本，退出后由它完成覆盖并重启。
 * 脚本逻辑：等 1 秒让主进程退出 → 删除旧 exe 的临时备份 → 把 .new 覆盖成 exe → 启动新 exe → 自删。
 */
function installAndRestart(info: UpdateInfo, newFile: string): void {
  const exePath = process.execPath
  const dir = path.dirname(exePath)
  const backup = path.join(dir, 'NovaMC-old.exe')
  const script = path.join(dir, 'update.bat')

  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    'timeout /t 1 /nobreak >nul',
    `move /Y "${exePath}" "${backup}"`,
    `move /Y "${newFile}" "${exePath}"`,
    `del "${backup}"`,
    `start "" "${exePath}"`,
    `del "%~f0"`
  ].join('\r\n')

  fs.writeFileSync(script, bat, 'utf8')

  // 用 cmd 后台启动脚本，随后退出应用
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref()

  // 稍等片刻让脚本先起来，再退出主程序
  setTimeout(() => app.quit(), 300)
}
