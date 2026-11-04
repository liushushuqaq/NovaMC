/**
 * Minecraft 皮肤头部的等轴测渲染（浏览器端）。
 *
 * 为什么运行时渲染而不是预生成图片：
 * 用户可以上传任意皮肤 PNG，每张皮肤的第二层（帽子/头巾/头发 overlay）内容都不同。
 * 运行时渲染才能自动支持双层——第二层透明的像素自动跳过，露出下层。
 *
 * 渲染方式：立方体 6 个面各自做仿射映射。
 * 正交投影下，一个平面矩形投到屏幕上是平行四边形，所以 `setTransform` + `drawImage`
 * 就能精确贴合，不需要逐像素反解（那样既慢又容易把贴图贴反）。
 *
 * 皮肤布局（64×64，1.8+ 格式）：
 *   第一层头部：(0,8) 右侧 / (8,8) 正面 / (16,8) 左侧 / (24,8) 背面
 *                (8,0) 顶面 / (16,0) 底面
 *   第二层头部：整体右移 32px，纵向布局相同
 * 64×32 的老皮肤只有第一层。
 */

type Vec3 = [number, number, number]
type FaceName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'

/** 一个面的贴图坐标（64×64 皮肤下的像素范围，含左上、不含右下） */
type UvRect = [number, number, number, number]

const LAYER1_UV: Record<FaceName, UvRect> = {
  front: [8, 8, 16, 16],
  back: [24, 8, 32, 16],
  right: [0, 8, 8, 16],
  left: [16, 8, 24, 16],
  top: [8, 0, 16, 8],
  bottom: [16, 0, 24, 8]
}

const LAYER2_UV: Record<FaceName, UvRect> = {
  front: [40, 8, 48, 16],
  back: [56, 8, 64, 16],
  right: [32, 8, 40, 16],
  left: [48, 8, 56, 16],
  top: [40, 0, 48, 8],
  bottom: [48, 0, 56, 8]
}

/**
 * 每个面的几何。
 * origin —— 贴图左上角对应的 3D 点
 * u      —— 贴图「向右」在 3D 里的方向（长度 = 边长 2）
 * v      —— 贴图「向下」在 3D 里的方向
 * normal —— 外法线，用来剔除背面
 *
 * 坐标：x 向右、y 向上、z 指向观察者（+z 是脸的方向），边长 2，中心在原点。
 */
interface FaceGeo {
  origin: Vec3
  u: Vec3
  v: Vec3
  normal: Vec3
  /** 面亮度：让立方体有体积感，又不至于把深色皮肤压死 */
  lum: number
}

const FACES: Record<FaceName, FaceGeo> = {
  // 正面：从 +z 看，贴图向右 = +x，向下 = -y
  front: {
    origin: [-1, 1, 1],
    u: [2, 0, 0],
    v: [0, -2, 0],
    normal: [0, 0, 1],
    lum: 1
  },
  // 背面：从 -z 看，贴图向右 = -x
  back: {
    origin: [1, 1, -1],
    u: [-2, 0, 0],
    v: [0, -2, 0],
    normal: [0, 0, -1],
    lum: 0.72
  },
  // 头部右侧（x = +1）：从 +x 看，贴图向右朝后（-z）
  right: {
    origin: [1, 1, 1],
    u: [0, 0, -2],
    v: [0, -2, 0],
    normal: [1, 0, 0],
    lum: 0.84
  },
  // 头部左侧（x = -1）：从 -x 看，贴图向右朝后（+z）
  left: {
    origin: [-1, 1, -1],
    u: [0, 0, 2],
    v: [0, -2, 0],
    normal: [-1, 0, 0],
    lum: 0.84
  },
  // 顶面：贴图上方是后脑（-z），下方是额头（+z）
  top: {
    origin: [-1, 1, -1],
    u: [2, 0, 0],
    v: [0, 0, 2],
    normal: [0, 1, 0],
    lum: 1.06
  },
  // 底面：基本看不到，给个暗值
  bottom: {
    origin: [-1, -1, 1],
    u: [2, 0, 0],
    v: [0, 0, -2],
    normal: [0, -1, 0],
    lum: 0.62
  }
}

const FACE_ORDER: FaceName[] = ['back', 'right', 'left', 'bottom', 'top', 'front']

export interface SkinHeadOptions {
  /** 输出边长（正方形，实际像素） */
  size?: number
  /** 水平旋转角（度），正值把头的左侧转向观察者 */
  yaw?: number
  /** 俯仰角（度），正值略微俯视头顶 */
  pitch?: number
  /** 第二层相对第一层的放大比例（Minecraft 里 overlay 比本体大一圈） */
  overlayScale?: number
}

function deg2rad(d: number): number {
  return (d * Math.PI) / 180
}

/** 绕 Y 轴再绕 X 轴旋转 */
function rotate(v: Vec3, yaw: number, pitch: number): Vec3 {
  const [x, y, z] = v
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const x1 = x * cy + z * sy
  const z1 = -x * sy + z * cy
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const y2 = y * cp - z1 * sp
  const z2 = y * sp + z1 * cp
  return [x1, y2, z2]
}

function mul(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k]
}

/** 这张皮肤有没有第二层（64×32 老皮肤没有） */
export function hasOverlayLayer(source: HTMLImageElement | HTMLCanvasElement): boolean {
  const h = 'naturalHeight' in source ? source.naturalHeight || source.height : source.height
  const w = 'naturalWidth' in source ? source.naturalWidth || source.width : source.width
  return w >= 64 && h >= 64
}

/** 第二层的头部区域（不含透明像素）是否真的有内容 */
export function hasSecondLayerContent(source: HTMLImageElement | HTMLCanvasElement): boolean {
  if (!hasOverlayLayer(source)) return false
  const w = 'naturalWidth' in source ? source.naturalWidth || source.width : source.width
  const k = w / 64
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')
  if (!ctx) return false
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(source, 0, 0, 64 * k, 64 * k, 0, 0, 64, 64)
  for (const name of FACE_ORDER) {
    const [x0, y0, x1, y1] = LAYER2_UV[name]
    const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true
    }
  }
  return false
}

/**
 * 把皮肤渲染成等轴测 3D 头部头像。
 *
 * 六个面按仿射变换贴合，第二层放大一圈叠在上面；两层的透明像素都自然透出下层。
 */
export function renderSkinHead(
  source: HTMLImageElement | HTMLCanvasElement,
  canvas: HTMLCanvasElement,
  options: SkinHeadOptions = {}
): void {
  const size = Math.max(16, Math.round(options.size ?? 128))
  const yaw = deg2rad(options.yaw ?? 20)
  const pitch = deg2rad(options.pitch ?? 14)
  // 原版里 overlay 每边比本体大 0.25 像素（8 → 8.5）
  const overlayScale = options.overlayScale ?? 1.0625

  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, size, size)
  ctx.imageSmoothingEnabled = false

  const srcW =
    'naturalWidth' in source ? source.naturalWidth || source.width : source.width
  const srcH =
    'naturalHeight' in source ? source.naturalHeight || source.height : source.height
  if (!srcW || !srcH) return

  // 高清皮肤（128×128 等）按比例换算 UV
  const k = srcW / 64
  const overlay = srcW >= 64 && srcH >= 64

  // --- 投影比例：用外层立方体的八个角求包围盒，保证留白均匀 ---
  const corners: Vec3[] = []
  for (const sx of [-overlayScale, overlayScale]) {
    for (const sy of [-overlayScale, overlayScale]) {
      for (const sz of [-overlayScale, overlayScale]) corners.push([sx, sy, sz])
    }
  }
  const rotated = corners.map((c) => rotate(c, yaw, pitch))
  const xs = rotated.map((p) => p[0])
  const ys = rotated.map((p) => p[1])
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  const span = Math.max(spanX, spanY, 0.001)

  const scale = (size * 0.88) / span
  const cx = size / 2
  const cy = size / 2

  const drawLayer = (
    uvs: Record<FaceName, UvRect>,
    inflate: number,
    withLight: boolean
  ): void => {
    for (const name of FACE_ORDER) {
      const geo = FACES[name]
      const n = rotate(geo.normal, yaw, pitch)
      if (n[2] <= 0.02) continue // 背面剔除

      const o = rotate(mul(geo.origin, inflate), yaw, pitch)
      const u = rotate(mul(geo.u, inflate), yaw, pitch)
      const v = rotate(mul(geo.v, inflate), yaw, pitch)

      const [sx0, sy0, sx1, sy1] = uvs[name]
      const w = (sx1 - sx0) * k
      const h = (sy1 - sy0) * k
      if (w <= 0 || h <= 0) continue

      // 屏幕坐标：x 向右、y 向下
      const ox = o[0] * scale + cx
      const oy = -o[1] * scale + cy
      const ux = u[0] * scale
      const uy = -u[1] * scale
      const vx = v[0] * scale
      const vy = -v[1] * scale

      // 退化面（几乎侧对镜头）直接跳过，避免除零
      if (Math.abs(ux * vy - uy * vx) < 1e-6) continue

      ctx.save()
      ctx.setTransform(ux / w, uy / w, vx / h, vy / h, ox, oy)
      ctx.filter = withLight ? `brightness(${geo.lum})` : 'none'
      ctx.drawImage(source, sx0 * k, sy0 * k, w, h, 0, 0, w, h)
      ctx.restore()
    }
  }

  // 第一层（本体）→ 第二层（帽子/头发 overlay 放大一圈叠上去）
  drawLayer(LAYER1_UV, 1, true)
  if (overlay) drawLayer(LAYER2_UV, overlayScale, false)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.filter = 'none'
}

export interface SkinFaceOptions {
  /** 输出边长（实际像素） */
  size?: number
  /** 是否叠加第二层（帽子 / 头发 / 头巾），默认叠 */
  overlay?: boolean
}

/**
 * 正面 2D 头像 —— 和游戏里、NameMC 上看到的一模一样。
 *
 * 只取头部的正脸 8×8 像素整数倍放大（保证每个皮肤像素都是正方形，不会糊），
 * 上面再盖一层第二层的同区域，透明像素自然透出第一层。
 * 小尺寸（≤64px）下比等轴测清晰得多，脸能占满整个框。
 */
export function renderSkinFace(
  source: HTMLImageElement | HTMLCanvasElement,
  canvas: HTMLCanvasElement,
  options: SkinFaceOptions = {}
): void {
  const size = Math.max(8, Math.round(options.size ?? 64))
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, size, size)
  ctx.imageSmoothingEnabled = false

  const srcW =
    'naturalWidth' in source ? source.naturalWidth || source.width : source.width
  const srcH =
    'naturalHeight' in source ? source.naturalHeight || source.height : source.height
  if (!srcW || !srcH) return

  // 高清皮肤按比例换算 UV
  const k = srcW / 64
  const hasOverlay = srcW >= 64 && srcH >= 64

  // 整数倍放大：8 个皮肤像素 → 每格 cell 个设备像素
  const cell = Math.max(1, Math.floor(size / 8))
  const drawSize = cell * 8
  const off = Math.floor((size - drawSize) / 2)

  ctx.drawImage(source, 8 * k, 8 * k, 8 * k, 8 * k, off, off, drawSize, drawSize)
  if (hasOverlay && options.overlay !== false) {
    // 第二层直接叠上去，透明像素不会盖住第一层
    ctx.drawImage(source, 40 * k, 8 * k, 8 * k, 8 * k, off, off, drawSize, drawSize)
  }
}

/**
 * 载入一张皮肤 PNG。
 * 走 data URL 而不是文件路径，避免 Electron 的 file:// 跨域限制。
 */
export function loadSkinImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('皮肤图片加载失败'))
    img.src = src
  })
}
