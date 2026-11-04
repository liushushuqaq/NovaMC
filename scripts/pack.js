/**
 * 打包入口。
 *
 * 为什么不用 `electron-builder --win` 直接跑：
 * electron-builder 会先把 Electron 运行时解到 <out>/win-unpacked/ 再压成单文件 exe，
 * 这个中间目录在 Windows 上经常被句柄锁住（app.asar 删不掉），
 * 于是下一次打包在「清理旧目录」这一步就 EBUSY 失败。
 *
 * 做法：每次打包都用一个全新的临时目录，工程目录里不留任何中间产物。
 * 成品 exe 仍由 after-build.js 归档到 NovaMC/<产品名>-<版本>/。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PROJECT_DIR = path.resolve(__dirname, '..')
const PLATFORM = process.argv[2] || 'win'
const OUT_DIR = path.join(os.tmpdir(), `novamc-build-${Date.now()}`)

const binary = path.join(
  PROJECT_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
)

console.log(`[pack] platform=${PLATFORM} outDir=${OUT_DIR}`)

const res = spawnSync(binary, [`--${PLATFORM}`, `-c.directories.output=${OUT_DIR}`], {
  cwd: PROJECT_DIR,
  stdio: 'inherit',
  // .cmd 在 Windows 上必须通过 shell 启动
  shell: process.platform === 'win32'
})

// 中间产物在系统临时目录，删不掉也不占工程空间，尽力清理即可
try {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
} catch {
  /* 被占用就交给系统清理 */
}

process.exit(res.status ?? 1)
