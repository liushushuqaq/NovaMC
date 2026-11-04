import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { createContext, type AppContext, type DataRoot } from './context'
import { registerIpc } from './ipc'
import { registerUpdateIpc } from './update'
import { provisionJava } from '../core/javaProvision'

// 冒烟测试用：把用户目录指到临时路径，避免污染真实配置
if (process.env.NOVAMC_USER_DATA) app.setPath('userData', process.env.NOVAMC_USER_DATA)

/** 目录能不能写：写个探针文件再删掉，别等真正下载时才报 EACCES */
function probeWritable(dir: string): { ok: boolean; reason?: string } {
  const probe = path.join(dir, `.novamc-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException).code ?? String(e) }
  }
}

/**
 * 绿色版：数据全部落在 exe 同级目录，拷走文件夹就能用。
 * 必须在 app ready 之前同步决定——userData 一旦被 Chromium 用起来就改不动了。
 */
function resolveDataRoot(): DataRoot {
  const override = process.env.NOVAMC_DATA_ROOT
  if (override) return { root: override, portable: true }

  // 开发模式不往工程目录里拉游戏文件，否则 git 里全是几个 GB 的下载物
  if (!app.isPackaged) return { root: path.join(app.getPath('userData'), 'NovaMC'), portable: false }

  // portable target 会把自己解压到 %TEMP% 再运行，execPath 指向的是临时目录，
  // 真实位置由 NSIS 启动器写进 PORTABLE_EXECUTABLE_DIR
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'))
  const probe = probeWritable(base)
  if (probe.ok) return { root: base, portable: true }

  return {
    root: path.join(app.getPath('userData'), 'NovaMC'),
    portable: false,
    fallbackReason: `${base} 不可写（${probe.reason}），已回落到用户目录`
  }
}

const dataRoot = resolveDataRoot()
// 绿色版把 Chromium 缓存也收进数据目录，AppData 里不留任何痕迹
if (dataRoot.portable && !process.env.NOVAMC_USER_DATA) {
  app.setPath('userData', path.join(dataRoot.root, '.launcher'))
}

/**
 * 打包之后没有控制台可看，主进程一旦抛出未捕获异常，用户只会看到"点了没反应"。
 * 这里落一份 crash.log 到用户目录，既是用户反馈时的排障依据，也是我们自己的保险。
 */
function logCrash(kind: string, error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const line = `[${new Date().toISOString()}] ${kind}: ${text}\n`
  console.error(line)
  try {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'crash.log'), line)
  } catch {
    /* 日志都写不进去就只能放弃，不能因此再抛一次 */
  }
}

process.on('uncaughtException', (e) => logCrash('uncaughtException', e))
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e))

let ctx: AppContext | null = null
let mainWindow: BrowserWindow | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

function resolvePreload(): string {
  return path.join(__dirname, '../preload/index.js')
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    backgroundColor: '#0B0D10',
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 14 } : undefined,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 冒烟测试：加载完成后截一张图再退出，CI 里可做视觉回归
  if (process.env.NOVAMC_SMOKE) {
    const outFile = process.env.NOVAMC_SMOKE
    const delay = Number(process.env.NOVAMC_SMOKE_DELAY ?? 2600)
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const target = Number(process.env.NOVAMC_SMOKE_PAGE ?? -1)
          if (target >= 0) {
            await mainWindow?.webContents.executeJavaScript(
              `(()=>{const b=document.querySelectorAll('.nav-item')[${target}];b&&b.click();})()`
            )
            await new Promise((r) => setTimeout(r, 900))
          }
          // 可选的按钮点击：用来截到"正在安装"这种瞬时状态
          const clickText = process.env.NOVAMC_SMOKE_CLICK
          if (clickText) {
            await mainWindow?.webContents.executeJavaScript(
              `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(
                clickText
              )});b&&b.click();return !!b;})()`
            )
            await new Promise((r) => setTimeout(r, Number(process.env.NOVAMC_SMOKE_WAIT ?? 6000)))
          }
          // 任意脚本：逐个分区截图时比一级一级找按钮省事
          const script = process.env.NOVAMC_SMOKE_SCRIPT
          if (script) {
            const ret = await mainWindow?.webContents.executeJavaScript(script)
            if (ret !== undefined && ret !== null) console.log('[smoke] script →', ret)
            await new Promise((r) => setTimeout(r, Number(process.env.NOVAMC_SMOKE_WAIT ?? 800)))
          }
          // 断言脚本：结果直接写进 stdout，退出码 0 = 通过，1 = 失败
          // 用于冒烟阶段自动校验「凭据是否真的落盘」这类断言
          const assertScript = process.env.NOVAMC_SMOKE_ASSERT
          if (assertScript) {
            try {
              const ret = await mainWindow?.webContents.executeJavaScript(assertScript)
              const ok = ret === true || ret === 'true' || (ret && ret.ok === true)
              console.log(`[smoke][assert] ${ok ? 'PASS' : 'FAIL'} → ${JSON.stringify(ret)}`)
              if (!ok) process.exitCode = 1
            } catch (e) {
              console.log(`[smoke][assert] ERROR → ${String(e)}`)
              process.exitCode = 1
            }
            await new Promise((r) => setTimeout(r, 400))
          }
          const image = await mainWindow?.webContents.capturePage()
          if (image) fs.writeFileSync(outFile, image.toPNG())
          console.log(`[smoke] captured → ${outFile}`)
        } catch (e) {
          console.error('[smoke] capture failed', e)
        }
        app.quit()
      }, delay)
    })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    await mainWindow.loadURL(devUrl)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  ctx = await createContext(dataRoot)
  const cfg = await ctx.config.load()
  nativeTheme.themeSource = cfg.theme === 'system' ? 'system' : cfg.theme

  // 上次退出时还在「导入中」的实例其实已经断了，标成中断，别让它一直转圈
  await ctx.instances.reconcileImports().catch(() => undefined)

  // 命令行式受管 JDK 安装，用于 CI 与排障
  if (process.env.NOVAMC_PROVISION) {
    const major = Number(process.env.NOVAMC_PROVISION)
    try {
      const javaPath = await provisionJava(major, ctx.paths, ctx.pool, ctx.http, ctx.platform, ctx.mirror.mode, (p) =>
        console.log(
          `[provision] ${p.phase} ${p.done}/${p.total} ${p.doneBytes}/${p.totalBytes}B ${p.speedBps}B/s ${p.label}`
        )
      )
      console.log(`[provision] java = ${javaPath}`)
    } catch (e) {
      console.error('[provision] failed', e)
    }
    app.quit()
    return
  }

  // 命令行式安装，用于 CI 与排障：NOVAMC_INSTALL=1.21.4
  if (process.env.NOVAMC_INSTALL) {
    const versionId = process.env.NOVAMC_INSTALL
    const abortMs = Number(process.env.NOVAMC_INSTALL_ABORT ?? 0)
    if (abortMs) setTimeout(() => {
      console.log('[install] abort by timer')
      app.exit(0)
    }, abortMs)
    try {
      let lastLog = 0
      await ctx.installer.install(versionId, {
        stage: (stage, label) => console.log(`[install] stage=${stage} ${label ?? ''}`),
        tick: (stage, s) => {
          const now = Date.now()
          if (now - lastLog < 1200 && s.doneBytes < s.totalBytes) return
          lastLog = now
          console.log(
            `[install] ${stage} ${s.doneFiles}/${s.totalFiles} ${(s.doneBytes / 1048576).toFixed(1)}/${(
              s.totalBytes / 1048576
            ).toFixed(1)}MB ${(s.speedBps / 1048576).toFixed(1)}MB/s`
          )
        }
      })
      console.log('[install] done')
    } catch (e) {
      console.error('[install] failed', e)
    }
    app.quit()
    return
  }

  registerIpc(ctx)
  registerUpdateIpc(ctx)
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS 关窗不退出应用，此时不该把游戏一起收掉
  if (process.platform !== 'darwin') {
    ctx?.launcher.killNow()
    app.quit()
  }
})

app.on('before-quit', () => {
  ctx?.launcher.killNow()
  ctx?.tunnel.killNow()
})
