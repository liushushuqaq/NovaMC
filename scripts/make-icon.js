/**
 * 生成打包用应用图标：build/icon.png（1024×1024，带透明圆角）
 *
 * 做法是用 Electron 起一个隐藏窗口，把 SVG 画进 canvas 再导出 PNG。
 * 不用截图是因为 canvas 能保证 alpha 通道干净 —— 截图容易被窗口底色的白边污染。
 *
 * 用法：npm run icon
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const OUT = path.join(process.cwd(), 'build', 'icon.png')

const SVG = `
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1A2E22"/>
      <stop offset="0.55" stop-color="#101A14"/>
      <stop offset="1" stop-color="#070B09"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.14" r="0.75">
      <stop offset="0" stop-color="#6EE07A" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#6EE07A" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="faceTop" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#A6FBB0"/>
      <stop offset="1" stop-color="#6EE07A"/>
    </linearGradient>
    <linearGradient id="faceLeft" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#57CB6F"/>
      <stop offset="1" stop-color="#37954E"/>
    </linearGradient>
    <linearGradient id="faceRight" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2C8546"/>
      <stop offset="1" stop-color="#1A5730"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#glow)"/>
  <rect x="2" y="2" width="1020" height="1020" rx="226" fill="none"
        stroke="#6EE07A" stroke-opacity="0.18" stroke-width="4"/>

  <g stroke="#06100A" stroke-opacity="0.42" stroke-width="7" stroke-linejoin="round">
    <path d="M512 232 L780 372 L512 512 L244 372 Z" fill="url(#faceTop)"/>
    <path d="M244 372 L512 512 L512 792 L244 652 Z" fill="url(#faceLeft)"/>
    <path d="M780 372 L512 512 L512 792 L780 652 Z" fill="url(#faceRight)"/>
  </g>

  <path d="M512 232 L780 372 L512 512 L244 372 Z" fill="#FFFFFF" fill-opacity="0.07"/>
</svg>`

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })

  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent('<html><body></body></html>')}`
  )

  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = ${SIZE}
        c.height = ${SIZE}
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0, ${SIZE}, ${SIZE})
        resolve(c.toDataURL('image/png'))
      }
      img.onerror = () => reject(new Error('SVG 解码失败'))
      img.src = ${JSON.stringify(svgUrl)}
    })
  `)

  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '')
  const buf = Buffer.from(base64, 'base64')
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, buf)
  console.log(`[icon] ${OUT} ${(buf.length / 1024).toFixed(1)} KB`)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
