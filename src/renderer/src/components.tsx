import type { ReactElement, ReactNode } from 'react'
import type { TaskProgress } from '@core/types'
import { Icon } from './icons'
import { useApp } from './store'

export function ProgressBar({ value, tone }: { value: number; tone?: 'warn' | 'danger' }): ReactElement {
  return (
    <div className={`progress ${tone ?? ''}`}>
      <i style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  )
}

export function Modal({
  title,
  desc,
  children,
  footer,
  wide,
  onClose
}: {
  title: string
  desc?: string
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  onClose(): void
}): ReactElement {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>{title}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={14} />
          </button>
        </div>
        {desc ? <div className="desc">{desc}</div> : null}
        {children}
        {footer ? <div className="foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }): ReactElement {
  return (
    <div className="empty">
      <b>{title}</b>
      {hint ? <span>{hint}</span> : null}
    </div>
  )
}

export function Toasts(): ReactElement {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismiss)
  return (
    <div className="toasts">
      {toasts.slice(-4).map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <b>{t.title}</b>
          {t.body ? <span>{t.body}</span> : null}
        </div>
      ))}
    </div>
  )
}

export function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** 阶段中文名。主进程只传枚举，文案留在渲染层，方便以后做多语言 */
const STAGE_TEXT: Record<string, string> = {
  queued: '排队中',
  resolve: '解析版本',
  client: '下载客户端',
  libraries: '依赖库',
  assets: '资源文件',
  natives: '解压本地库',
  java: 'Java 运行时',
  loader: '安装加载器',
  mods: '模组文件',
  launch: '启动游戏',
  done: '已完成'
}

export function stageText(stage: string): string {
  return STAGE_TEXT[stage] ?? stage
}

/**
 * 进度既不能只看文件数（一个 28 MB 的客户端 jar 只算 1 个文件），
 * 也不能只看字节数（资源索引尾部全是几十 KB 的音效文件，字节几乎不动）。
 * 两个维度各占一半，任何一种工作量都会推动进度条。
 */
export function taskPercent(task: TaskProgress): number {
  if (task.error || task.stage === 'done') return 1
  const byBytes = task.totalBytes > 0 ? task.doneBytes / task.totalBytes : null
  const byFiles = task.totalFiles > 0 ? task.doneFiles / task.totalFiles : null
  if (byBytes !== null && byFiles !== null) return Math.min(1, byBytes * 0.5 + byFiles * 0.5)
  if (byBytes !== null) return Math.min(1, byBytes)
  if (byFiles !== null) return Math.min(1, byFiles)
  return 0
}

/** 剩余时间取两种估算里更慢的那个：真实耗时不会比任一维度估计更快 */
export function fmtEta(task: TaskProgress): string {
  const elapsed = (task.elapsedMs ?? 0) / 1000
  if (elapsed < 3 || task.stage === 'done' || task.error) return ''
  const remainBytes = Math.max(0, task.totalBytes - task.doneBytes)
  const remainFiles = Math.max(0, task.totalFiles - task.doneFiles)
  if (remainBytes === 0 && remainFiles === 0) return ''

  const estimates: number[] = []
  if (task.speedBps > 0 && remainBytes > 0) estimates.push(remainBytes / task.speedBps)
  if (task.doneFiles > 0 && remainFiles > 0) estimates.push((elapsed / task.doneFiles) * remainFiles)
  if (!estimates.length) return ''

  const sec = Math.round(Math.max(...estimates))
  if (sec < 5) return '即将完成'
  if (sec < 60) return `剩 ${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `剩 ${min} 分 ${sec % 60} 秒`
  return `剩 ${Math.floor(min / 60)} 小时 ${min % 60} 分`
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function relTime(iso?: string): string {
  if (!iso) return '从未启动'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return fmtDate(iso)
}
