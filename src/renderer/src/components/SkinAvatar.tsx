import { useEffect, useRef, useState } from 'react'
import { renderSkinFace, renderSkinHead, loadSkinImage } from '../skinHead'
import steveSkin from '../assets/skins/steve-skin.png'
import alexSkin from '../assets/skins/alex-skin.png'
import type { ReactElement } from 'react'

/**
 * 账号头像。
 *
 * 默认用「正面 2D」—— 和游戏内、各大皮肤站一致：只取头部正脸 8×8 像素整数倍放大，
 * 再叠上第二层（帽子/头发/头巾 overlay）。小尺寸下（44-56px）五官依然清楚，
 * 这是等轴测 3D 做不到的——3D 头在 56px 里脸只占十几像素，糊成一团。
 *
 * `variant="head"` 保留等轴测 3D，给需要更大展示位的场景用。
 */
export default function SkinAvatar({
  skinModel,
  skinUrl,
  size = 56,
  variant = 'face'
}: {
  skinModel?: 'classic' | 'slim'
  /** 自定义皮肤的 data URL */
  skinUrl?: string | null
  size?: number
  /** face = 正面 2D（默认），head = 等轴测 3D */
  variant?: 'face' | 'head'
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)

  // 内置皮肤纹理（Steve / Alex 的原始 64×64 展开图）
  const builtin = skinModel === 'slim' ? alexSkin : steveSkin

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return

    const source = skinUrl || builtin
    // 2 倍像素画布：1x 屏幕缩一半、2x 屏幕正好一一对应，都不会糊
    const renderSize = Math.max(64, Math.round(size * 2))

    loadSkinImage(source)
      .then((img) => {
        if (cancelled) return
        try {
          if (variant === 'head') {
            renderSkinHead(img, canvas, { size: renderSize, yaw: 18, pitch: 12 })
          } else {
            renderSkinFace(img, canvas, { size: renderSize })
          }
          setFailed(false)
        } catch {
          if (!cancelled) setFailed(true)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [skinUrl, builtin, size, variant])

  return (
    <div
      className="acct-avatar"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.19) }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        aria-label="账号头像"
      />
      {failed ? <span style={{ fontSize: 9, color: 'var(--text-3)' }}>加载失败</span> : null}
    </div>
  )
}
