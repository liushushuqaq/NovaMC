/** 构建时由 electron.vite.config.ts 注入，值与 package.json 的 version 一致 */
declare const __APP_VERSION__: string

/// <reference types="vite/client" />

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

/** Vite 的 ?worker 导入返回 Worker 构造器 */
declare module '*?worker' {
  const workerConstructor: {
    new (options?: { name?: string }): Worker
  }
  export default workerConstructor
}
/** Vite 的 ?worker&inline 导入（内联成 blob，规避 asar 无法加载 worker 的问题） */
declare module '*?worker&inline' {
  const workerConstructor: {
    new (options?: { name?: string }): Worker
  }
  export default workerConstructor
}
