/**
 * 打包收尾钩子（electron-builder 的 afterAllArtifactBuild）
 *
 * 目的：每次打包把成品放进 NovaMC/<产品名>-<版本>/ 里，不同版本互不覆盖。
 * 例如 0.0.0 → NovaMC/NovaMC-0.0.0/NovaMC-0.0.0.exe
 *
 * 用钩子而不是 npm script，是为了让直接调用 electron-builder 也得到同样的目录结构。
 * 注意：electron-builder 传给钩子的 BuildResult 只有
 * { outDir, artifactPaths, platformToTargets, configuration }，没有 packager，
 * 所以项目根目录与版本号在这里自行解析。
 */
const fs = require('node:fs')
const path = require('node:path')

const PROJECT_DIR = path.resolve(__dirname, '..')

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'))
}

/** 优先 rename（同盘瞬时完成、不产生删除），跨盘时退回复制。 */
function relocate(from, to) {
  // 同名版本重新打包时目标已存在，Windows 上不先删会 EPERM
  try {
    fs.rmSync(to, { force: true })
  } catch {
    /* 删不掉就让下面的 rename 报错，别静默吞掉 */
  }
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      fs.copyFileSync(from, to)
      fs.unlinkSync(from)
      return
    }
    throw e
  }
}

module.exports = async function afterAllArtifactBuild(buildResult) {
  const pkg = readPackageJson()
  const version = pkg.version
  const productName = (pkg.build && pkg.build.productName) || pkg.name

  const folderName = `${productName}-${version}`
  const targetDir = path.join(PROJECT_DIR, 'NovaMC', folderName)
  fs.mkdirSync(targetDir, { recursive: true })

  // 只搬最终产物（exe / dmg / AppImage …），不碰 win-unpacked、debug yml 与 blockmap
  const artifacts = (buildResult.artifactPaths || []).filter((p) => /\.(exe|dmg|AppImage|deb|rpm|zip)$/i.test(p))

  const moved = []
  for (const src of artifacts) {
    if (!fs.existsSync(src)) continue
    const dest = path.join(targetDir, path.basename(src))
    if (path.resolve(src) === path.resolve(dest)) {
      moved.push(dest)
      continue
    }
    relocate(src, dest)
    moved.push(dest)
  }

  if (moved.length === 0) {
    console.warn(`[after-build] 没有找到可归档的产物，检查 ${buildResult.outDir}`)
  }
  for (const p of moved) console.log(`[after-build] ${path.relative(PROJECT_DIR, p)}`)

  // 返回新路径，electron-builder 的日志会指向真实位置
  return moved
}
