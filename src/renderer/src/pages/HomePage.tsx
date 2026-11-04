import { useMemo, useState } from 'react'
import { useApp, invoke } from '../store'
import { Icon } from '../icons'
import { Empty, Modal, relTime, stageText, taskPercent } from '../components'
import type { InstanceConfig } from '@core/types'
import type { ReactElement, CSSProperties } from 'react'

export function coverStyle(seed: string, bg?: string): CSSProperties {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  const c1 = `hsl(${h} 44% 46%)`
  const c2 = `hsl(${(h + 24) % 360} 38% 18%)`
  const base: CSSProperties = {
    background: `radial-gradient(120% 90% at 78% 10%, rgba(255,220,150,0.28), transparent 60%), linear-gradient(140deg, ${c1}, ${c2})`
  }
  if (!bg) return base
  // 自定义背景：压一层深色渐变，保证白色标题在任何图上都读得清
  return {
    ...base,
    backgroundImage: `linear-gradient(to top, rgba(6,12,9,0.78), rgba(6,12,9,0.18) 58%, rgba(6,12,9,0.32)), url(${bg})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center'
  }
}

export function loaderLabel(inst: InstanceConfig): string {
  if (inst.loader.kind === 'vanilla') return 'Vanilla'
  return `${inst.loader.kind === 'fabric' ? 'Fabric' : inst.loader.kind}${inst.loader.version ? ` ${inst.loader.version}` : ''}`
}

export default function HomePage(): ReactElement {
  const config = useApp((s) => s.config)
  const instances = useApp((s) => s.instances)
  const accounts = useApp((s) => s.accounts)
  const running = useApp((s) => s.running)
  const progress = useApp((s) => s.progress)
  const backgrounds = useApp((s) => s.backgrounds)
  const setPage = useApp((s) => s.setPage)
  const notify = useApp((s) => s.notify)
  const reload = useApp((s) => s.reload)
  const [busy, setBusy] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)

  const current = useMemo(() => {
    if (!instances.length) return null
    return instances.find((i) => i.id === config?.lastInstanceId) ?? instances[0]
  }, [instances, config?.lastInstanceId])

  const activeAccount = useMemo(() => {
    if (!accounts.length) return null
    return accounts.find((a) => a.id === config?.activeAccountId) ?? accounts[0]
  }, [accounts, config?.activeAccountId])

  const task = progress[0]
  const isRunning = running && current && running === current.id

  const start = async (inst: InstanceConfig): Promise<void> => {
    if (inst.importState) {
      notify(
        'warn',
        inst.importState.status === 'importing' ? '这个实例还在导入中' : '这个实例的导入没有完成',
        '到「实例」页面可以看进度或重试'
      )
      setPage('instances')
      return
    }
    if (!activeAccount) {
      notify('warn', '还没有账号', '先去「账号」页面创建一个离线账号')
      setPage('accounts')
      return
    }
    setBusy(true)
    const res = await invoke(() => window.nova.launch.start(inst.id), '启动失败')
    setBusy(false)
    if (res) {
      useApp.setState({ running: inst.id })
      await window.nova.config.patch({ lastInstanceId: inst.id })
      await reload()
    }
  }

  const stop = async (): Promise<void> => {
    await invoke(() => window.nova.launch.kill(), '停止失败')
    useApp.setState({ running: null })
  }

  if (!current) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>欢迎使用 NovaMC</h1>
            <div className="sub">先创建一个实例，然后就可以下载并启动游戏了</div>
          </div>
        </div>
        <div className="section">
          <Empty title="还没有任何实例" hint="到「实例」页面新建一个：选好游戏版本和加载器即可" />
          <div className="mt16">
            <button className="btn primary" onClick={() => setPage('instances')}>
              <Icon name="plus" size={14} />
              新建实例
            </button>
          </div>
        </div>
      </>
    )
  }

  const hour = new Date().getHours()
  const greeting = hour < 6 ? '凌晨好' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <>
      <div className="page-head">
        <div>
          <div className="sub">
            {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
            {`  ·  ${instances.length} 个实例`}
          </div>
          <h1 style={{ marginTop: 4 }}>
            {greeting}
            {activeAccount ? `，${activeAccount.name}` : ''}
          </h1>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => setPage('versions')}>
            <Icon name="stack" size={14} />
            版本库
          </button>
          <button className="btn primary" onClick={() => setPage('instances')}>
            <Icon name="plus" size={14} />
            新建实例
          </button>
        </div>
      </div>

      <div className="section" style={{ display: 'flex', gap: 18, alignItems: 'stretch' }}>
        <div className={`hero grow ${backgrounds[current.id] ? 'has-bg' : ''}`}>
          {backgrounds[current.id] ? (
            <div className="hero-bg" style={{ backgroundImage: `url(${backgrounds[current.id]})` }} />
          ) : null}
          <div className="grid-lines" />
          <div className="pill">
            <i className="dot" style={{ background: current.importState ? '#f0a05c' : '#7bef87' }} />
            {current.importState
              ? current.importState.status === 'importing'
                ? `导入中 ${Math.round(current.importState.percent * 100)}%`
                : '导入未完成'
              : isRunning
                ? '运行中'
                : task && !task.error
                  ? `${stageText(task.stage)} ${Math.round(taskPercent(task) * 100)}%`
                  : '已就绪'}
          </div>
          <h2>{current.name}</h2>
          <div className="meta">
            Minecraft {current.gameVersion} · {loaderLabel(current)} · {current.memory.maxMb} MB ·{' '}
            {relTime(current.lastPlayedAt)}
          </div>
          <div className="actions">
            {current.importState ? (
              <button className="btn lg primary" onClick={() => setPage('instances')}>
                <Icon name="download" size={13} />
                {current.importState.status === 'importing' ? '查看导入进度' : '导入未完成，去实例页处理'}
              </button>
            ) : isRunning ? (
              <button className="btn lg danger" onClick={() => void stop()}>
                <Icon name="stop" size={14} />
                结束游戏
              </button>
            ) : (
              <button className="btn lg primary" onClick={() => void start(current)} disabled={busy}>
                <Icon name="play" size={13} />
                {busy ? (task?.stage === 'java' ? '准备 Java…' : '启动中…') : '开始游戏'}
              </button>
            )}
            <button
              className="icon-btn"
              title="打开实例目录"
              onClick={() => {
                void window.nova.system.paths().then((r) => {
                  if (r.ok) void window.nova.system.openPath(`${r.data.instances}/${current.slug}`)
                })
              }}
            >
              <Icon name="folder" size={18} />
            </button>
            <button className="icon-btn" title="实例设置" onClick={() => setPage('instances')}>
              <Icon name="gear" size={18} />
            </button>
            <button className="icon-btn" title="卡片背景" onClick={() => setBgOpen(true)}>
              <Icon name="palette" size={18} />
            </button>
          </div>
        </div>

        <div style={{ width: 302, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 11 }}>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>本次启动</span>
              <button className="btn sm ghost" onClick={() => setPage('instances')}>
                编辑
              </button>
            </div>
            <Row label="游戏版本" value={`${current.gameVersion} · ${loaderLabel(current)}`} />
            <Row
              label="Java 运行时"
              value={config?.javaPreference && config.javaPreference !== 'auto' ? '手动指定' : '自动匹配'}
            />
            <Row label="内存分配" value={`${current.memory.minMb} / ${current.memory.maxMb} MB`} />
            <Row label="窗口分辨率" value={`${current.window.width} × ${current.window.height}${current.window.fullscreen ? ' · 全屏' : ''}`} />
          </div>

          <div className="card" style={{ padding: 16, flex: 1 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>当前账号</span>
              <button className="btn sm ghost" onClick={() => setPage('accounts')}>
                管理
              </button>
            </div>
            {activeAccount ? (
              <>
                <div className="row" style={{ gap: 9 }}>
                  <span className="seed">{activeAccount.name.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{activeAccount.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                      {activeAccount.type === 'offline' ? '离线账号' : 'Microsoft · 正版'}
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Row label="账号类型" value={activeAccount.type === 'offline' ? '离线（无验证）' : 'Microsoft'} />
                  <Row label="登录状态" value={activeAccount.type === 'offline' ? '本地生成' : '令牌有效'} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 10, lineHeight: 1.7 }}>
                  UUID
                  <br />
                  <span className="mono" style={{ fontSize: 9.5 }}>
                    {activeAccount.id}
                  </span>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                还没有账号
                <br />
                <button className="btn sm primary mt8" onClick={() => setPage('accounts')}>
                  去添加
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="section" style={{ marginTop: 6 }}>
        <div className="section-head">
          <h2>最近实例</h2>
          <span className="hint">共 {instances.length} 个</span>
        </div>
        <div className="quick-grid">
          {instances.slice(0, 6).map((inst) => (
            <button key={inst.id} className="quick-card" onClick={() => void start(inst)}>
              <span className="thumb" style={coverStyle(inst.slug, backgrounds[inst.id])} />
              <span className="grow">
                <b>{inst.name}</b>
                <span>
                  {inst.gameVersion} · {loaderLabel(inst)}
                </span>
                <span style={{ display: 'block', color: 'var(--text-3)' }}>{relTime(inst.lastPlayedAt)}</span>
              </span>
              <Icon name="play" size={12} style={{ color: 'var(--text-3)' }} />
            </button>
          ))}
        </div>
      </div>

      {bgOpen ? (
        <BackgroundModal
          instance={current}
          preview={backgrounds[current.id] ?? null}
          onClose={() => setBgOpen(false)}
          onDone={async () => {
            setBgOpen(false)
            await reload()
          }}
        />
      ) : null}
    </>
  )
}

/** 首页卡片背景：上传 / 自动取世界图 / 恢复默认 */
function BackgroundModal({
  instance,
  preview,
  onClose,
  onDone
}: {
  instance: InstanceConfig
  preview: string | null
  onClose(): void
  onDone(): Promise<void>
}): ReactElement {
  const notify = useApp((s) => s.notify)
  const [busy, setBusy] = useState<'upload' | 'auto' | null>(null)

  const upload = async (): Promise<void> => {
    setBusy('upload')
    const res = await window.nova.instances.pickBackground(instance.id)
    setBusy(null)
    if (!res.ok) {
      notify('error', '设置背景失败', res.message)
      return
    }
    if (!res.data) return
    notify('success', '卡片背景已更新', '已按 16:9 裁切并压缩到 1920 宽')
    await onDone()
  }

  const auto = async (): Promise<void> => {
    setBusy('auto')
    const res = await window.nova.instances.autoBackground(instance.id)
    setBusy(null)
    if (!res.ok) {
      notify('warn', '没找到可用的世界图片', res.message)
      return
    }
    if (!res.data) return
    notify(
      'success',
      res.data.source === 'world' ? '已使用最近存档的缩略图' : '已使用最新一张游戏截图',
      res.data.source === 'world' ? '来自 saves/<存档>/icon.png' : '来自 screenshots/ 目录'
    )
    await onDone()
  }

  const clear = async (): Promise<void> => {
    const res = await window.nova.instances.clearBackground(instance.id)
    if (!res.ok) {
      notify('error', '恢复默认失败', res.message)
      return
    }
    await onDone()
  }

  return (
    <Modal
      title={`「${instance.name}」的卡片背景`}
      desc="上传一张图，或者直接用这个世界自己的截图。图片会裁成 16:9 压进实例目录，不占额外空间。"
      onClose={onClose}
      footer={
        <button className="btn ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="bg-preview" style={preview ? { backgroundImage: `url(${preview})` } : coverStyle(instance.slug)}>
        <span className="bg-preview-tag">
          {instance.background
            ? instance.background.source === 'upload'
              ? '自定义上传'
              : instance.background.source === 'world'
                ? '存档缩略图'
                : '游戏截图'
            : '默认渐变'}
        </span>
      </div>

      <div className="bg-options">
        <button className="bg-option" onClick={() => void upload()} disabled={busy !== null}>
          <span className="bg-option-icon">
            <Icon name="palette" size={16} />
          </span>
          <span className="grow">
            <b>{busy === 'upload' ? '正在处理图片…' : '上传本地图片'}</b>
            <span>png / jpg / webp，自动裁成 16:9</span>
          </span>
        </button>

        <button className="bg-option" onClick={() => void auto()} disabled={busy !== null}>
          <span className="bg-option-icon">
            <Icon name="globe" size={16} />
          </span>
          <span className="grow">
            <b>{busy === 'auto' ? '正在找世界图片…' : '自动获取世界图片'}</b>
            <span>优先最近存档缩略图，其次最新截图</span>
          </span>
        </button>

        <button className="bg-option" onClick={() => void clear()} disabled={busy !== null || !instance.background}>
          <span className="bg-option-icon">
            <Icon name="refresh" size={16} />
          </span>
          <span className="grow">
            <b>恢复默认渐变</b>
            <span>删掉已保存的背景图</span>
          </span>
        </button>
      </div>
    </Modal>
  )
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '5px 0' }}>
      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{label}</span>
      <span style={{ fontSize: 11.5, color: 'var(--text)' }}>{value}</span>
    </div>
  )
}
