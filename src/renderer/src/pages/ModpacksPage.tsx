import { useState } from 'react'
import { useApp, invoke } from '../store'
import { Icon } from '../icons'
import { Empty, ProgressBar, stageText, taskPercent } from '../components'
import type { ModpackSummary } from '@core/types'
import type { ReactElement } from 'react'

export default function ModpacksPage(): ReactElement {
  const progress = useApp((s) => s.progress)
  const reload = useApp((s) => s.reload)
  const notify = useApp((s) => s.notify)
  const instances = useApp((s) => s.instances)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModpackSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  const task = progress.find((p) => p.title.includes('整合包'))

  const search = async (): Promise<void> => {
    setLoading(true)
    const list = await invoke(() => window.nova.modpack.search(query || 'optimized'), '搜索失败')
    setResults(list ?? [])
    setLoading(false)
  }

  const install = async (pack: ModpackSummary): Promise<void> => {
    setInstalling(pack.projectId)
    const inst = await invoke(() => window.nova.modpack.install(pack.projectId, pack.title), '安装整合包失败')
    setInstalling(null)
    if (inst) {
      notify('success', '整合包安装完成', `${inst.name} · ${inst.gameVersion}`)
      await reload()
      useApp.getState().setPage('instances')
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>整合包</h1>
          <div className="sub">来自 Modrinth · 自动安装 Fabric 与全部模组依赖</div>
        </div>
        <div className="actions">
          <input
            className="input"
            style={{ width: 240 }}
            placeholder="搜索整合包，例如 all the mods"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
          />
          <button className="btn primary" onClick={() => void search()} disabled={loading}>
            <Icon name="search" size={13} />
            {loading ? '搜索中…' : '搜索'}
          </button>
        </div>
      </div>

      {task ? (
        <div className="section">
          <div className="card" style={{ padding: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11.5 }}>{task.title}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                {stageText(task.stage)} · {task.label} · {Math.round(taskPercent(task) * 100)}%
              </span>
            </div>
            <ProgressBar value={taskPercent(task)} />
          </div>
        </div>
      ) : null}

      <div className="section">
        {results === null ? (
          <Empty title="搜一个整合包开始" hint="支持 Modrinth 上的 Fabric 整合包；Forge / NeoForge 暂未支持自动安装" />
        ) : results.length === 0 ? (
          <Empty title="没有找到结果" hint="换个关键词试试" />
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {results.map((pack) => {
              const installed = instances.some((i) => i.source?.projectId === pack.projectId)
              return (
                <div key={pack.projectId} className="list-row" style={{ padding: 14 }}>
                  {pack.iconUrl ? (
                    <img
                      src={pack.iconUrl}
                      alt=""
                      width={44}
                      height={44}
                      style={{ borderRadius: 10, objectFit: 'cover', flex: 'none' }}
                    />
                  ) : (
                    <span className="thumb" style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--surface)' }} />
                  )}
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <b>{pack.title}</b>
                      {pack.loaders.map((l) => (
                        <span key={l} className="badge accent">
                          {l}
                        </span>
                      ))}
                    </div>
                    <div className="m" style={{ marginTop: 3 }}>
                      {pack.description}
                    </div>
                    <div className="m" style={{ marginTop: 3, color: 'var(--text-3)' }}>
                      {pack.gameVersions.slice(0, 4).join(' · ')} · {Math.round(pack.downloads / 1000)}k 次下载
                    </div>
                  </div>
                  {installed ? (
                    <span className="badge">已安装</span>
                  ) : (
                    <button
                      className="btn sm primary"
                      disabled={installing === pack.projectId}
                      onClick={() => void install(pack)}
                    >
                      {installing === pack.projectId ? '安装中…' : '安装'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
