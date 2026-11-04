import { useMemo, useState } from 'react'
import { useApp, invoke } from '../store'
import { Icon } from '../icons'
import { fmtDate, ProgressBar, stageText, taskPercent } from '../components'
import type { VersionType } from '@core/types'
import type { ReactElement } from 'react'

const TABS: { key: 'all' | 'release' | 'snapshot' | 'legacy'; label: string }[] = [
  { key: 'all', label: '全部版本' },
  { key: 'release', label: '正式版' },
  { key: 'snapshot', label: '快照' },
  { key: 'legacy', label: '旧版 Beta / Alpha' }
]

const TYPE_TEXT: Record<VersionType, string> = {
  release: '正式版',
  snapshot: '快照',
  old_beta: '旧版 Beta',
  old_alpha: '旧版 Alpha'
}

/** 未安装时按版本号猜一个运行时，仅用于列表展示；真实值以安装后的 version.json 为准 */
function javaMajorFor(id: string): number {
  const m = /^1\.(\d+)/.exec(id)
  if (!m) return 21
  const minor = Number(m[1])
  if (minor >= 20) return 21
  if (minor >= 18) return 17
  if (minor >= 17) return 16
  return 8
}

export default function VersionsPage(): ReactElement {
  const manifest = useApp((s) => s.manifest)
  const installed = useApp((s) => s.installed)
  const progress = useApp((s) => s.progress)
  const reload = useApp((s) => s.reload)
  const notify = useApp((s) => s.notify)

  const [tab, setTab] = useState<'all' | 'release' | 'snapshot' | 'legacy'>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(40)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const installedMap = useMemo(() => new Map(installed.map((i) => [i.id, i])), [installed])

  const rows = useMemo(() => {
    const list = manifest?.versions ?? []
    const filtered = list.filter((v) => {
      if (tab === 'release' && v.type !== 'release') return false
      if (tab === 'snapshot' && v.type !== 'snapshot') return false
      if (tab === 'legacy' && v.type !== 'old_beta' && v.type !== 'old_alpha') return false
      if (query && !v.id.toLowerCase().includes(query.toLowerCase())) return false
      return true
    })
    return filtered
  }, [manifest, tab, query])

  const taskFor = (id: string) => progress.find((p) => p.title.includes(id) && p.stage !== 'done')

  const sync = async (): Promise<void> => {
    setSyncing(true)
    await invoke(() => window.nova.versions.list(true), '同步失败')
    await reload()
    setSyncing(false)
  }

  const install = async (id: string): Promise<void> => {
    setBusy(id)
    await invoke(() => window.nova.versions.install(id), `${id} 安装失败`)
    setBusy(null)
    await reload()
    notify('success', `${id} 安装完成`)
  }

  const remove = async (id: string, instanceCount: number): Promise<void> => {
    if (instanceCount > 0) {
      notify('warn', '仍有实例在使用该版本', `请先删除引用它的 ${instanceCount} 个实例`)
      return
    }
    await invoke(() => window.nova.versions.remove(id), '删除失败')
    await reload()
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Minecraft 版本库</h1>
          <div className="sub">
            共 {manifest?.versions.length ?? 0} 个版本 · 最新正式版 {manifest?.latest.release ?? '—'} · 最新快照{' '}
            {manifest?.latest.snapshot ?? '—'}
          </div>
        </div>
        <div className="actions">
          <input
            className="input"
            style={{ width: 190 }}
            placeholder="搜索版本号"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn ghost" onClick={() => void sync()} disabled={syncing}>
            <Icon name="refresh" size={13} className={syncing ? 'spin' : undefined} />
            同步列表
          </button>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="section">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '30%' }}>版本号</th>
              <th style={{ width: 120 }}>类型</th>
              <th style={{ width: 150 }}>发布日期</th>
              <th style={{ width: 120 }}>运行时</th>
              <th>状态 / 操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((v) => {
              const info = installedMap.get(v.id)
              const task = taskFor(v.id)
              return (
                <tr key={v.id}>
                  <td>
                    <span className="mono" style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>
                      {v.id}
                    </span>
                    {v.id === manifest?.latest.release ? (
                      <span className="badge accent" style={{ marginLeft: 8 }}>
                        最新
                      </span>
                    ) : null}
                  </td>
                  <td style={{ color: v.type === 'snapshot' ? 'var(--warn)' : v.type === 'release' ? 'var(--accent)' : 'var(--text-3)' }}>
                    {TYPE_TEXT[v.type]}
                  </td>
                  <td className="mono">{fmtDate(v.releaseTime)}</td>
                  <td className="mono">Java {info?.javaMajor ?? javaMajorFor(v.id)}</td>
                  <td>
                    {task ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 92, flex: 'none' }}>
                          <ProgressBar value={taskPercent(task)} />
                        </div>
                        <span style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                          {stageText(task.stage)} · {Math.round(taskPercent(task) * 100)}%
                        </span>
                      </div>
                    ) : info?.complete ? (
                      <div className="row" style={{ gap: 8 }}>
                        <span className="badge accent">
                          <i className="dot" />
                          已安装
                          {info.instanceCount > 0 ? ` · ${info.instanceCount} 个实例` : ''}
                        </span>
                        <button className="btn sm ghost" onClick={() => void remove(v.id, info.instanceCount)}>
                          删除
                        </button>
                      </div>
                    ) : info ? (
                      <div className="row" style={{ gap: 8 }}>
                        <span className="badge warn">未完成</span>
                        <button className="btn sm primary" disabled={busy === v.id} onClick={() => void install(v.id)}>
                          {busy === v.id ? '安装中…' : '继续安装'}
                        </button>
                        <button className="btn sm ghost" onClick={() => void remove(v.id, info.instanceCount)}>
                          删除
                        </button>
                      </div>
                    ) : (
                      <button className="btn sm primary" disabled={busy === v.id} onClick={() => void install(v.id)}>
                        {busy === v.id ? '安装中…' : '安装'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {rows.length === 0 ? (
          <div className="empty" style={{ marginTop: 16 }}>
            <b>没有匹配的版本</b>
            <span>换个关键词或切换筛选条件试试</span>
          </div>
        ) : null}

        {rows.length > limit ? (
          <div className="row mt16" style={{ justifyContent: 'center' }}>
            <button className="btn ghost" onClick={() => setLimit((n) => n + 60)}>
              加载更多（{rows.length - limit}）
            </button>
          </div>
        ) : null}
      </div>
    </>
  )
}
