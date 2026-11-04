/** 构建时由 electron.vite.config.ts 注入，值与 package.json 的 version 一致 */
declare const __APP_VERSION__: string

/** Vite 会把静态资源导入成一个 URL 字符串 */
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
