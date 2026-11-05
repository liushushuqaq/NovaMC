import { useEffect, useMemo, useState } from 'react'
import { useApp, type PageKey } from './store'
import { Icon, type IconName } from './icons'
import { Toasts, ProgressBar, Modal, fmtBytes, stageText, taskPercent, fmtEta } from './components'
import HomePage from './pages/HomePage'
import VersionsPage from './pages/VersionsPage'
import InstancesPage from './pages/InstancesPage'
import ModpacksPage from './pages/ModpacksPage'
import AccountsPage from './pages/AccountsPage'
import TunnelPage from './pages/TunnelPage'
import SettingsPage from './pages/SettingsPage'
import type { UpdateCheckResult, UpdateProgress } from '@core/types'
import type { ReactElement } from 'react'

const NAV_GAME: { key: PageKey; label: string; icon: IconName }[] = [
  { key: 'home', label: '主页', icon: 'home' },
  { key: 'versions', label: '版本管理', icon: 'stack' },
  { key: 'instances', label: '实例', icon: 'grid' },
  { key: 'modpacks', label: '整合包', icon: 'package' }
]

const NAV_SYSTEM: { key: PageKey; label: string; icon: IconName }[] = [
  { key: 'accounts', label: '账号', icon: 'user' },
  { key: 'tunnel', label: '内网穿透', icon: 'link' },
  { key: 'settings', label: '设置', icon: 'gear' }
]

const PAGES: Record<PageKey, { title: string; render: () => ReactElement }> = {
  home: { title: '主页', render: () => <HomePage /> },
  versions: { title: '版本管理', render: () => <VersionsPage /> },
  instances: { title: '实例', render: () => <InstancesPage /> },
  modpacks: { title: '整合包', render: () => <ModpacksPage /> },
  accounts: { title: '账号', render: () => <AccountsPage /> },
  tunnel: { title: '内网穿透', render: () => <TunnelPage /> },
  settings: { title: '设置', render: () => <SettingsPage /> }
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

export default function App(): ReactElement {
  const ready = useApp((s) => s.ready)
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const config = useApp((s) => s.config)
  const accounts = useApp((s) => s.accounts)
  const progress = useApp((s) => s.progress)
  const theme = config?.theme ?? 'dark'
  const density = config?.density ?? 'comfortable'
  const accent = config?.accent ?? 'green'

  // 在线更新状态
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null)
  const [showUpdate, setShowUpdate] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [prog, setProg] = useState<UpdateProgress | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    void useApp.getState().init()
  }, [])

  // 启动后自动检测一次更新；有新版本就在标题栏亮起加号并弹出更新窗
  useEffect(() => {
    let alive = true
    void window.nova.update
      .check()
      .then((r) => {
        if (!alive || !r.ok) return
        setUpdate(r.data)
        if (r.data.hasUpdate) setShowUpdate(true)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // 订阅下载进度
  useEffect(() => {
    const off = window.nova.events.onUpdate((p) => setProg(p))
    return off
  }, [])

  // SettingsPage 手动「检查更新」后，同步状态到全局（标题栏加号 + 弹窗）
  useEffect(() => {
    const onChecked = (e: Event): void => {
      const detail = (e as CustomEvent<UpdateCheckResult>).detail
      if (!detail) return
      setUpdate(detail)
      if (detail.hasUpdate) setShowUpdate(true)
    }
    window.addEventListener('nova:update-checked', onChecked)
    return () => window.removeEventListener('nova:update-checked', onChecked)
  }, [])

  useEffect(() => {
    const apply = (): void => {
      const resolved =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : theme
      document.documentElement.dataset.theme = resolved
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  // 密度与强调色只换 token，不改任何布局代码
  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])

  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])

  const activeAccount = useMemo(() => {
    if (!accounts.length) return null
    return accounts.find((a) => a.id === config?.activeAccountId) ?? accounts[0]
  }, [accounts, config?.activeAccountId])

  const task = progress[0]
  const taskPct = task ? taskPercent(task) : 0
  const taskStage = task ? stageText(task.stage) : ''
  const taskEta = task ? fmtEta(task) : ''
  // 只在真有量的时候显示体积/文件数，否则留一行"0 / 0 文件"反而像出了错
  const taskDetail = useMemo(() => {
    if (!task) return ''
    if (task.error) return task.error.message
    const parts: string[] = []
    if (task.totalBytes > 0) parts.push(`${fmtBytes(task.doneBytes)} / ${fmtBytes(task.totalBytes)}`)
    else if (task.totalFiles > 1) parts.push(`${task.doneFiles} / ${task.totalFiles} 文件`)
    if (task.speedBps) parts.push(`${fmtBytes(task.speedBps)}/s`)
    return parts.join(' · ')
  }, [task])

  const startDownload = async (): Promise<void> => {
    setDownloading(true)
    setProg({ phase: 'downloading', doneBytes: 0, totalBytes: update?.latest?.size ?? 0 })
    const r = await window.nova.update.download()
    setDownloading(false)
    if (r.ok && r.data.downloaded) setDownloaded(true)
  }

  const doInstall = async (): Promise<void> => {
    setInstalling(true)
    await window.nova.update.install()
  }

  if (!ready) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center' }}>
        <div className="col" style={{ alignItems: 'center', gap: 10, color: 'var(--text-3)' }}>
          <Icon name="stack" size={26} className="spin" />
          <span style={{ fontSize: 11 }}>正在加载 NovaMC…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="titlebar">
        <div className="left">
          <i className="dot" />
          <span className="titlebar-page">
            {`${PAGES[page].title} — NovaMC${activeAccount ? ` · ${activeAccount.name}` : ''}`}
          </span>
        </div>
        {isMac ? null : (
          <div className="wincontrols">
            <button onClick={() => void window.nova.win.minimize()} aria-label="最小化">
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
            <button onClick={() => void window.nova.win.toggleMaximize()} aria-label="最大化">
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="2.5" y="2.5" width="7" height="7" rx="1.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </svg>
            </button>
            <button className="close" onClick={() => void window.nova.win.close()} aria-label="关闭">
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <div className="body">
        <aside className="sidebar">
          <div className="brand">
            <div className="logo">
              <Icon name="stack" size={17} />
            </div>
            <div>
              <div className="name">
                NovaMC
                {update?.hasUpdate ? (
                  <button
                    className="update-badge"
                    title={`有新版本 ${update.latest?.version}`}
                    onClick={() => setShowUpdate(true)}
                  >
                    NEW
                  </button>
                ) : null}
              </div>
              <div className="sub">Launcher {__APP_VERSION__}</div>
            </div>
          </div>

          <div className="nav-label">游戏</div>
          {NAV_GAME.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${page === item.key ? 'active' : ''}`}
              onClick={() => setPage(item.key)}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </button>
          ))}

          <div className="nav-label">系统</div>
          {NAV_SYSTEM.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${page === item.key ? 'active' : ''}`}
              onClick={() => setPage(item.key)}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </button>
          ))}

          <div className="spacer" />

          {task ? (
            <div className="side-card">
              <div className="row">
                <span>下载队列</span>
                <span style={{ color: task.error ? 'var(--danger)' : 'var(--accent)' }}>
                  {task.error ? '失败' : task.stage === 'done' ? '完成' : `${Math.round(taskPct * 100)}%`}
                </span>
              </div>
              <div className="task">{task.title}</div>
              <ProgressBar value={taskPct} tone={task.error ? 'danger' : undefined} />
              <div className={`stage-line ${task.stage === 'done' ? 'done' : ''}`}>
                <span className="stage-name">
                  {task.error ? '中断' : taskStage}
                  {task.stageIndex && task.stageCount && task.stageCount > 1
                    ? ` ${task.stageIndex}/${task.stageCount}`
                    : ''}
                </span>
                <span>{task.error ? '' : taskEta}</span>
              </div>
              {taskDetail ? <div className="file-line">{taskDetail}</div> : null}
              {task.label && !task.error ? (
                <div className="file-line" style={{ color: 'var(--text-3)', opacity: 0.7 }}>
                  {task.label}
                </div>
              ) : null}
            </div>
          ) : null}

          <button className="account-chip" onClick={() => setPage('accounts')}>
            <span className="seed">{activeAccount ? activeAccount.name.slice(0, 1).toUpperCase() : '?'}</span>
            <span className="who">
              <b>{activeAccount ? activeAccount.name : '未登录'}</b>
              <span>{activeAccount ? (activeAccount.type === 'offline' ? '离线账号' : 'Microsoft · 正版') : '点击添加账号'}</span>
            </span>
            <Icon name="chevron" size={12} style={{ color: 'var(--text-3)' }} />
          </button>
        </aside>

        <main className="content">{PAGES[page].render()}</main>
      </div>

      {showUpdate && update?.latest ? (
        <Modal
          title="发现新版本"
          desc={`当前 ${update.currentVersion} → ${update.latest.version}`}
          onClose={() => setShowUpdate(false)}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              <button className="btn ghost sm" onClick={() => setShowUpdate(false)}>
                取消
              </button>
              {downloaded ? (
                <button className="btn primary sm" disabled={installing} onClick={() => void doInstall()}>
                  {installing ? '正在更新…' : '重启更新'}
                </button>
              ) : (
                <button className="btn primary sm" disabled={downloading} onClick={() => void startDownload()}>
                  {downloading ? '下载中…' : '更新'}
                </button>
              )}
            </div>
          }
        >
          <div className="update-notes">
            {update.latest.notes ? (
              <pre className="update-notes-body">{update.latest.notes}</pre>
            ) : (
              <span className="settings-empty">本次更新没有附带说明</span>
            )}
          </div>
          {downloading && prog ? (
            <div style={{ marginTop: 12 }}>
              <ProgressBar value={prog.totalBytes ? prog.doneBytes / prog.totalBytes : 0} />
              <div className="set-foot" style={{ marginTop: 6 }}>
                <span className="hint">
                  {prog.totalBytes
                    ? `${fmtBytes(prog.doneBytes)} / ${fmtBytes(prog.totalBytes)}`
                    : '正在下载…'}
                </span>
              </div>
            </div>
          ) : null}
          <div className="set-foot" style={{ marginTop: 12 }}>
            <span className="hint">下载完成后点击「重启更新」，程序会自动替换并重启</span>
          </div>
        </Modal>
      ) : null}

      <Toasts />
    </div>
  )
}
