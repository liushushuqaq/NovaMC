import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useApp, invoke } from '../store'
import { Icon, type IconName } from '../icons'
import { ProgressBar, fmtBytes, fmtEta, stageText, taskPercent } from '../components'
import type { AccentKey, AppConfig, StorageUsage, SystemInfo } from '@core/types'

type SectionKey = 'appearance' | 'java' | 'memory' | 'window' | 'network' | 'storage' | 'about'

interface SectionMeta {
  key: SectionKey
  label: string
  icon: IconName
  group: string
  title: string
  desc: string
  /** 搜索命中用的额外关键词 */
  keywords: string
}

const SECTIONS: SectionMeta[] = [
  {
    key: 'appearance',
    label: '外观与主题',
    icon: 'palette',
    group: '常规',
    title: '外观与主题',
    desc: '配色与界面密度立即生效；「跟随系统」会读取操作系统的深浅色偏好，切换系统主题时自动跟随。',
    keywords: '主题 深色 浅色 颜色 密度 强调色 界面'
  },
  {
    key: 'java',
    label: 'Java 运行时',
    icon: 'cpu',
    group: '常规',
    title: 'Java 运行时',
    desc: '启动时按版本 JSON 里的 javaVersion.majorVersion 自动挑选运行时；本机没有可用 Java 时会自己下一个，不用手动装 JDK。',
    keywords: 'java jdk jre 运行时 环境 版本 路径 jvm'
  },
  {
    key: 'memory',
    label: '内存与性能',
    icon: 'gauge',
    group: '常规',
    title: '内存与性能',
    desc: '这里是新建实例的默认值，已有实例可以在实例详情里单独覆盖。分配过高会和系统抢内存，反而更容易卡顿。',
    keywords: '内存 性能 堆 分配 mb 卡顿'
  },
  {
    key: 'window',
    label: '游戏窗口',
    icon: 'window',
    group: '常规',
    title: '游戏窗口',
    desc: '新建实例时的默认窗口尺寸。只影响之后创建的实例，已有实例不受影响。',
    keywords: '窗口 分辨率 全屏 尺寸 画面'
  },
  {
    key: 'network',
    label: '下载源与并发',
    icon: 'globe',
    group: '下载与存储',
    title: '下载源与并发',
    desc: '资源索引、依赖库、资源对象都按这里的设置走。下载失败会自动换源重试，不需要手动切换。',
    keywords: '下载 镜像 源 并发 重试 超时 网络 bmclapi 官方'
  },
  {
    key: 'storage',
    label: '目录与存储',
    icon: 'folder',
    group: '下载与存储',
    title: '目录与存储',
    desc: '所有游戏文件、实例与日志都放在同一个根目录下，迁移时整个文件夹拷走即可。',
    keywords: '目录 存储 空间 占用 磁盘 路径 日志 清理'
  },
  {
    key: 'about',
    label: '关于与日志',
    icon: 'info',
    group: '其他',
    title: '关于与日志',
    desc: '版本信息、运行环境与最近的日志文件。反馈问题的时候，附上最新一份日志最有用。',
    keywords: '关于 版本 日志 信息 重置 恢复默认'
  }
]

const GROUPS = ['常规', '下载与存储', '其他']

const DEFAULTS: Record<SectionKey, Partial<AppConfig>> = {
  appearance: { theme: 'dark', density: 'comfortable', accent: 'green' },
  java: { javaPreference: 'auto', verifyOnLaunch: false },
  memory: { defaultMemory: { minMb: 2048, maxMb: 8192 } },
  window: { defaultWindow: { width: 1280, height: 720, fullscreen: false } },
  network: { mirror: 'auto', concurrency: 8, downloadRetries: 3, downloadTimeoutSec: 30 },
  storage: {},
  about: {}
}

const THEMES: { key: AppConfig['theme']; label: string }[] = [
  { key: 'dark', label: '深色' },
  { key: 'light', label: '浅色' },
  { key: 'system', label: '跟随系统' }
]

const ACCENTS: { key: AccentKey; color: string; label: string }[] = [
  { key: 'green', color: '#6ee07a', label: '草绿' },
  { key: 'blue', color: '#5aa9f8', label: '靛蓝' },
  { key: 'violet', color: '#a78bfa', label: '紫罗兰' },
  { key: 'amber', color: '#f2b34c', label: '赤金' },
  { key: 'rose', color: '#f4788e', label: '绯粉' }
]

const THEME_LABEL: Record<AppConfig['theme'], string> = {
  dark: '深色',
  light: '浅色',
  system: '跟随系统'
}

const DENSITY_LABEL: Record<AppConfig['density'], string> = {
  comfortable: '舒适',
  compact: '紧凑'
}

const MIRROR_LABEL: Record<AppConfig['mirror'], string> = {
  auto: '自动',
  official: '仅官方',
  bmclapi: 'BMCLAPI'
}

const JAVA_MAP = [
  { range: '1.20.5 及更高', major: 'Java 21' },
  { range: '1.18 – 1.20.4', major: 'Java 17' },
  { range: '1.17 及更低', major: 'Java 8' }
]

/* ------------------------------------------------------------ 原子组件 */

function Switch({
  on,
  onChange,
  disabled
}: {
  on: boolean
  onChange(v: boolean): void
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={`toggle ${on ? 'on' : ''}`}
      style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
      onClick={() => onChange(!on)}
    />
  )
}

function Seg<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T
  options: { v: T; label: string }[]
  onChange(v: T): void
}): ReactElement {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Card({
  title,
  hint,
  children,
  tint
}: {
  title?: string
  hint?: string
  children: ReactNode
  tint?: boolean
}): ReactElement {
  return (
    <div className={`set-card ${tint ? 'tint' : ''}`}>
      {title ? (
        <div className="set-card-head">
          <span className="t">{title}</span>
          {hint ? <span className="h">{hint}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  )
}

function Row({
  title,
  desc,
  badge,
  control,
  onClick
}: {
  title: ReactNode
  desc?: ReactNode
  badge?: ReactNode
  control?: ReactNode
  onClick?(): void
}): ReactElement {
  return (
    <div className={`set-row ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="txt">
        <div className="t">
          {title}
          {badge}
        </div>
        {desc ? <div className="d">{desc}</div> : null}
      </div>
      {control ? <div className="ctl">{control}</div> : null}
    </div>
  )
}

/* ============================================================ 主体 */

export default function SettingsPage(): ReactElement {
  const config = useApp((s) => s.config)
  const patchConfig = useApp((s) => s.patchConfig)
  const notify = useApp((s) => s.notify)
  const progress = useApp((s) => s.progress)

  const [section, setSection] = useState<SectionKey>('appearance')
  const [query, setQuery] = useState('')

  const [detecting, setDetecting] = useState(false)
  const [provisioning, setProvisioning] = useState<number | null>(null)
  const [paths, setPaths] = useState<{
    root: string
    portable: boolean
    fallbackReason?: string
  } | null>(null)
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [scanning, setScanning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])

  useEffect(() => {
    void window.nova.system.paths().then((r) => r.ok && setPaths(r.data))
  }, [])

  useEffect(() => {
    if (config && config.javaRuntimes.length === 0) void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.javaRuntimes.length])

  // 按需加载，别为了显示一个数字把整棵树扫一遍
  useEffect(() => {
    if (section === 'about' && !info) {
      void window.nova.system.info().then((r) => r.ok && setInfo(r.data))
      void window.nova.system.logs().then((r) => r.ok && setLogs(r.data))
    }
    if (section === 'storage' && !usage) void scan(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section])

  const patch = (p: Partial<AppConfig>): void => void patchConfig(p)

  const detect = async (): Promise<void> => {
    setDetecting(true)
    const list = await invoke(() => window.nova.java.detect(), '探测 Java 失败')
    setDetecting(false)
    if (list) {
      await useApp.getState().reload()
      if (list.length) notify('success', `找到 ${list.length} 个 Java 运行时`)
      else notify('info', '本机没有检测到 Java', '不用管，启动游戏时会自动下载一个受管运行时')
    }
  }

  const provision = async (major: number): Promise<void> => {
    setProvisioning(major)
    const path = await invoke(() => window.nova.java.provision(major), `安装 Java ${major} 失败`)
    setProvisioning(null)
    if (path) {
      await useApp.getState().reload()
      notify('success', `Java ${major} 已就绪`, path)
    }
  }

  const addJavaByPath = async (): Promise<void> => {
    const picked = await invoke(() => window.nova.system.pickJava(), '选择 Java 失败')
    if (!picked) return
    patch({ javaPreference: picked })
    const list = await invoke(() => window.nova.java.detect(), '探测 Java 失败')
    if (list) {
      await useApp.getState().reload()
      notify('success', '已记住这个运行时', picked)
    }
  }

  const scan = async (force: boolean): Promise<void> => {
    setScanning(true)
    const res = await invoke(() => window.nova.system.storage(force), '统计目录失败')
    setScanning(false)
    if (res) setUsage(res)
  }

  const meta = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0]

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SECTIONS
    return SECTIONS.filter((s) => `${s.label} ${s.title} ${s.keywords}`.toLowerCase().includes(q))
  }, [query])

  if (!config) return <div className="section dim">读取配置中…</div>

  const resetSection = (): void => {
    const patchData = DEFAULTS[section]
    if (!Object.keys(patchData).length) {
      notify('info', '这一节没有可恢复的默认值')
      return
    }
    patch(patchData)
    notify('success', '已恢复本节默认值')
  }

  return (
    <div className="settings-page">
      <nav className="settings-nav">
        <div className="settings-search">
          <Icon name="search" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索设置项" />
        </div>

        {GROUPS.map((group) => {
          const items = visible.filter((s) => s.group === group)
          if (!items.length) return null
          return (
            <div className="settings-nav-group" key={group}>
              <div className="label">{group}</div>
              {items.map((item) => (
                <button
                  key={item.key}
                  className={`settings-nav-item ${section === item.key ? 'active' : ''}`}
                  onClick={() => setSection(item.key)}
                >
                  <Icon name={item.icon} size={14} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )
        })}

        <div className="spacer" />
        <div className="settings-nav-foot">
          <b>NovaMC {__APP_VERSION__}</b>
          <br />
          修改即时保存，无需确认
        </div>
      </nav>

      <div className="settings-main">
        <header className="settings-head">
          <div>
            <h1>{meta.title}</h1>
            <div className="sub">{meta.desc}</div>
          </div>
          <div className="actions">
            <button className="btn ghost sm" onClick={resetSection}>
              <Icon name="refresh" size={12} />
              恢复本节默认
            </button>
          </div>
        </header>

        <div className="settings-body">
          {section === 'appearance' ? <Appearance config={config} patch={patch} /> : null}
          {section === 'java' ? (
            <JavaSection
              config={config}
              patch={patch}
              notify={notify}
              progress={progress}
              detecting={detecting}
              provisioning={provisioning}
              onDetect={detect}
              onProvision={provision}
              onAddPath={addJavaByPath}
            />
          ) : null}
          {section === 'memory' ? <MemorySection config={config} patch={patch} /> : null}
          {section === 'window' ? <WindowSection config={config} patch={patch} /> : null}
          {section === 'network' ? <NetworkSection config={config} patch={patch} /> : null}
          {section === 'storage' ? (
            <StorageSection
              paths={paths}
              usage={usage}
              scanning={scanning}
              onScan={scan}
              notify={notify}
              onLogsCleared={() => void scan(true)}
            />
          ) : null}
          {section === 'about' ? (
            <AboutSection info={info} logs={logs} notify={notify} config={config} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ 外观 */

function Appearance({
  config,
  patch
}: {
  config: AppConfig
  patch(p: Partial<AppConfig>): void
}): ReactElement {
  return (
    <>
      <Card title="主题" hint="跟随系统时读取操作系统偏好">
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.key}
              className={`theme-card ${config.theme === t.key ? 'on' : ''}`}
              data-v={t.key}
              onClick={() => patch({ theme: t.key })}
            >
              <div className="theme-thumb">
                {t.key === 'system' ? (
                  <>
                    <div className="tt-half dark">
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="tt-half light">
                      <i />
                      <i />
                      <i />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="tt-side" />
                    <div className="tt-main">
                      <div className="tt-line w1" />
                      <div className="tt-line w2" />
                      <div className="tt-line w3" />
                      <div className="tt-pill" />
                    </div>
                  </>
                )}
              </div>
              <div className="theme-meta">
                <span>{t.label}</span>
                <span className="tick">
                  <Icon name="check" size={9} />
                </span>
              </div>
            </button>
          ))}
        </div>
      </Card>

      <Card title="界面">
        <Row
          title="界面密度"
          desc="紧凑会压缩行高与留白，小屏幕上能多显示几行"
          control={
            <Seg
              value={config.density}
              options={[
                { v: 'comfortable' as const, label: '舒适' },
                { v: 'compact' as const, label: '紧凑' }
              ]}
              onChange={(v) => patch({ density: v })}
            />
          }
        />
        <Row
          title="强调色"
          desc="只替换主色，背景层级与文字对比保持不变"
          control={
            <div className="accent-row">
              {ACCENTS.map((a) => (
                <button
                  key={a.key}
                  title={a.label}
                  aria-label={a.label}
                  className={`accent-dot ${config.accent === a.key ? 'on' : ''}`}
                  style={{ background: a.color }}
                  onClick={() => patch({ accent: a.key })}
                />
              ))}
            </div>
          }
        />
      </Card>
    </>
  )
}

/* ------------------------------------------------------------ Java */

function JavaSection({
  config,
  patch,
  notify,
  progress,
  detecting,
  provisioning,
  onDetect,
  onProvision,
  onAddPath
}: {
  config: AppConfig
  patch(p: Partial<AppConfig>): void
  notify(kind: 'info' | 'success' | 'warn' | 'error', title: string, body?: string): void
  progress: ReturnType<typeof useApp.getState>['progress']
  detecting: boolean
  provisioning: number | null
  onDetect(): Promise<void>
  onProvision(major: number): Promise<void>
  onAddPath(): Promise<void>
}): ReactElement {
  const auto = config.javaPreference === 'auto'
  const runtimes = config.javaRuntimes
  const recommended = useMemo(
    () => [...runtimes].sort((a, b) => b.major - a.major)[0] ?? null,
    [runtimes]
  )
  const selected = runtimes.find((j) => j.path === config.javaPreference) ?? null
  const javaTask = progress.find((p) => p.stage === 'java')

  const setAuto = (on: boolean): void => {
    if (on) {
      patch({ javaPreference: 'auto' })
      return
    }
    if (!runtimes.length) {
      notify('warn', '还没有可用的运行时', '先点「重新检测」，或下载一个受管运行时')
      return
    }
    patch({ javaPreference: recommended?.path ?? runtimes[0].path })
  }

  return (
    <>
      <Card title="匹配方式" hint={auto ? '按版本要求自动选择' : '已手动指定'}>
        <Row
          title="自动匹配 Java 版本"
          desc={
            auto
              ? `按版本 JSON 的 javaVersion.majorVersion 选择${
                  recommended ? `，当前会用到 Java ${recommended.major}` : ''
                }`
              : selected
                ? `当前固定用 Java ${selected.major} · ${selected.vendor ?? '未知供应商'} 启动所有实例`
                : '当前固定用已指定的运行时启动；那个路径已经不在了，建议重新选一个'
          }
          control={<Switch on={auto} onChange={setAuto} />}
        />
        <Row
          title="启动前校验运行时"
          desc="每次启动先跑一次 java -version，损坏或丢失时提前报错，而不是等游戏崩"
          control={<Switch on={config.verifyOnLaunch} onChange={(v) => patch({ verifyOnLaunch: v })} />}
        />
      </Card>

      <Card
        title="已检测到的运行时"
        hint={`${runtimes.length} 个${detecting ? ' · 检测中…' : ''}`}
      >
        {runtimes.length === 0 ? (
          <div className="settings-empty">
            {detecting ? '正在扫描常见的 JDK 安装位置…' : '还没有探测到 Java，点下面的「重新检测」试试'}
          </div>
        ) : (
          <div className="rt-list">
            {runtimes.map((j) => {
              const active = !auto && config.javaPreference === j.path
              return (
                <button
                  key={j.path}
                  className={`rt-row ${active ? 'on' : ''}`}
                  onClick={() => patch({ javaPreference: j.path })}
                >
                  <span className="rt-dot" />
                  <span className="meta">
                    <span className="name">
                      Java {j.major} · {j.vendor ?? '未知供应商'}
                      {j.managed ? <span className="badge accent">受管</span> : null}
                      {j.major === recommended?.major && !j.managed ? (
                        <span className="badge">推荐</span>
                      ) : null}
                    </span>
                    <span className="path">{j.path}</span>
                  </span>
                  {active ? <span className="badge accent">当前默认</span> : null}
                </button>
              )
            })}
          </div>
        )}
        <div className="set-foot">
          <span className="hint">受管运行时存放在数据目录的 runtime/ 下，可随目录一起迁移</span>
          <span className="acts">
            <button className="btn ghost sm" onClick={() => void onAddPath()}>
              <Icon name="folder" size={12} />
              添加路径
            </button>
            <button className="btn ghost sm" onClick={() => void onDetect()} disabled={detecting}>
              <Icon name="refresh" size={12} className={detecting ? 'spin' : undefined} />
              重新检测
            </button>
          </span>
        </div>
      </Card>

      <Card tint>
        <div className="set-row" style={{ borderTop: 'none', paddingTop: 14, paddingBottom: 14 }}>
          <div className="txt">
            <div className="t">
              <Icon name="download" size={13} style={{ color: 'var(--accent)' }} />
              缺少合适的运行时？
            </div>
            <div className="d">
              从清华 TUNA 镜像拉一个受管 JRE，约 49 MB，国内通常一分钟内完成；断点续传，失败可重试。
            </div>
          </div>
          <div className="ctl">
            <button
              className="btn primary sm"
              disabled={provisioning !== null}
              onClick={() => void onProvision(21)}
            >
              {provisioning === 21 ? '下载中…' : '下载 Java 21'}
            </button>
          </div>
        </div>

        {javaTask ? (
          <div className="set-field" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 10.5, marginBottom: 6 }}>
              <span>
                {stageText(javaTask.stage)} · {javaTask.label || '准备中'}
              </span>
              <span style={{ color: 'var(--accent)' }}>{Math.round(taskPercent(javaTask) * 100)}%</span>
            </div>
            <ProgressBar value={taskPercent(javaTask)} />
            <div style={{ fontSize: 9.5, color: 'var(--text-3)', marginTop: 6 }}>
              {javaTask.totalBytes > 0
                ? `${fmtBytes(javaTask.doneBytes)} / ${fmtBytes(javaTask.totalBytes)}`
                : '正在准备下载源'}
              {javaTask.speedBps ? ` · ${fmtBytes(javaTask.speedBps)}/s` : ''}
              {fmtEta(javaTask) ? ` · ${fmtEta(javaTask)}` : ''}
            </div>
          </div>
        ) : null}

        <div className="set-foot">
          <span className="hint">需要旧版本？也可以直接装 Java 17 / 8</span>
          <span className="acts">
            <button className="btn ghost sm" disabled={provisioning !== null} onClick={() => void onProvision(17)}>
              {provisioning === 17 ? '下载中…' : 'Java 17'}
            </button>
            <button className="btn ghost sm" disabled={provisioning !== null} onClick={() => void onProvision(8)}>
              {provisioning === 8 ? '下载中…' : 'Java 8'}
            </button>
          </span>
        </div>
      </Card>

      <Card title="版本对应关系" hint="自动匹配按这张表选择，手动指定可以覆盖">
        <div className="rt-list" style={{ borderTop: '1px solid var(--border)' }}>
          {JAVA_MAP.map((row) => (
            <div key={row.range} className="rt-row" style={{ cursor: 'default' }}>
              <span className="meta">
                <span className="name">{row.range}</span>
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>{row.major}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

/* ------------------------------------------------------------ 内存 */

function MemorySection({
  config,
  patch
}: {
  config: AppConfig
  patch(p: Partial<AppConfig>): void
}): ReactElement {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  useEffect(() => {
    void window.nova.system.info().then((r) => r.ok && setInfo(r.data))
  }, [])

  const { minMb, maxMb } = config.defaultMemory
  const total = info?.totalMemMb ?? 0
  const suggest = total ? Math.min(32768, Math.max(4096, Math.round((total * 0.35) / 512) * 512)) : 8192

  return (
    <>
      <Card title="默认内存分配" hint={total ? `本机 ${(total / 1024).toFixed(0)} GB` : undefined}>
        <div className="set-field">
          <div className="field-head">
            <span className="d">最大堆内存</span>
            <span className="v">{maxMb} MB</span>
          </div>
          <input
            type="range"
            min={1024}
            max={32768}
            step={512}
            value={maxMb}
            onChange={(e) => {
              const next = Number(e.target.value)
              patch({
                defaultMemory: { minMb: Math.min(minMb, next), maxMb: next }
              })
            }}
          />
          <div className="scale">
            <span style={{ left: '0%' }}>1G</span>
            <span style={{ left: '22.6%' }}>8G</span>
            <span style={{ left: '48.4%' }}>16G</span>
            <span style={{ left: '74.2%' }}>24G</span>
            <span style={{ left: '100%' }}>32G</span>
          </div>
          <div className="d" style={{ marginTop: 8 }}>
            原版给 2–4 GB 就够；整合包按模组数量给到 6–10 GB。超过本机内存的一半，系统会开始频繁换页。
          </div>
        </div>

        <div className="set-field">
          <div className="field-head">
            <span className="d">最小堆内存</span>
            <span className="v">{minMb} MB</span>
          </div>
          <input
            type="range"
            min={512}
            max={8192}
            step={256}
            value={minMb}
            onChange={(e) => {
              const next = Number(e.target.value)
              patch({ defaultMemory: { minMb: Math.min(next, maxMb), maxMb } })
            }}
          />
          <div className="scale">
            <span style={{ left: '0%' }}>512M</span>
            <span style={{ left: '20%' }}>2G</span>
            <span style={{ left: '46.7%' }}>4G</span>
            <span style={{ left: '73.3%' }}>6G</span>
            <span style={{ left: '100%' }}>8G</span>
          </div>
          <div className="d" style={{ marginTop: 8 }}>
            一般设成与最大堆相同即可，避免游戏中途反复扩堆造成卡顿。
          </div>
        </div>

        <div className="set-foot">
          <span className="hint">
            按本机内存推算的建议值：{(suggest / 1024).toFixed(1)} GB
          </span>
          <span className="acts">
            <button
              className="btn ghost sm"
              onClick={() => patch({ defaultMemory: { minMb: suggest, maxMb: suggest } })}
            >
              采用建议值
            </button>
          </span>
        </div>
      </Card>

      <Card title="本机硬件">
        <div className="kv">
          <dt>处理器</dt>
          <dd title={info?.cpuModel}>{info?.cpuModel ?? '—'}</dd>
          <dt>核心线程</dt>
          <dd>{info ? `${info.cpuCores} 线程` : '—'}</dd>
          <dt>物理内存</dt>
          <dd>{total ? `${(total / 1024).toFixed(1)} GB` : '—'}</dd>
          <dt>操作系统</dt>
          <dd>{info ? `${info.platform} ${info.arch} · ${info.osVersion}` : '—'}</dd>
        </div>
      </Card>
    </>
  )
}

/* ------------------------------------------------------------ 窗口 */

const RES_PRESETS = [
  { w: 1280, h: 720, label: '1280×720' },
  { w: 1600, h: 900, label: '1600×900' },
  { w: 1920, h: 1080, label: '1920×1080' },
  { w: 2560, h: 1440, label: '2560×1440' }
]

function WindowSection({
  config,
  patch
}: {
  config: AppConfig
  patch(p: Partial<AppConfig>): void
}): ReactElement {
  const { width, height, fullscreen } = config.defaultWindow
  const matched = RES_PRESETS.find((p) => p.w === width && p.h === height)

  return (
    <>
      <Card title="默认窗口尺寸" hint="仅影响新建实例">
        <div className="set-row" style={{ alignItems: 'flex-start' }}>
          <div className="txt">
            <div className="t">分辨率</div>
            <div className="d">多数整合包按 16:9 设计界面，非标准比例可能让 HUD 错位</div>
          </div>
          <div className="ctl" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
            <div className="seg" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {RES_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={matched?.label === p.label ? 'on' : ''}
                  onClick={() => patch({ defaultWindow: { width: p.w, height: p.h, fullscreen } })}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input mono"
                style={{ width: 88, height: 30, fontSize: 11 }}
                type="number"
                value={width}
                min={640}
                max={7680}
                onChange={(e) =>
                  patch({ defaultWindow: { width: Number(e.target.value) || width, height, fullscreen } })
                }
              />
              <span style={{ color: 'var(--text-3)', fontSize: 11 }}>×</span>
              <input
                className="input mono"
                style={{ width: 88, height: 30, fontSize: 11 }}
                type="number"
                value={height}
                min={480}
                max={4320}
                onChange={(e) =>
                  patch({ defaultWindow: { width, height: Number(e.target.value) || height, fullscreen } })
                }
              />
            </div>
          </div>
        </div>

        <Row
          title="全屏启动"
          desc="直接进全屏，省掉进游戏再按 F11"
          control={
            <Switch
              on={fullscreen}
              onChange={(v) => patch({ defaultWindow: { width, height, fullscreen: v } })}
            />
          }
        />
        <div className="set-foot">
          <span className="hint">尺寸只在创建实例时写入，之后可在实例详情里单独覆盖，互不影响</span>
        </div>
      </Card>
    </>
  )
}

/* ------------------------------------------------------------ 网络 */

const MIRRORS: { key: AppConfig['mirror']; label: string; desc: string; tag?: string }[] = [
  {
    key: 'auto',
    label: '自动（推荐）',
    desc: '优先走官方源，超时或校验失败自动回落到 BMCLAPI，两者都不通才会报错',
    tag: '默认'
  },
  { key: 'official', label: '仅官方', desc: '只用 Mojang 官方 CDN，海外网络稳定时最省事；国内可能很慢' },
  { key: 'bmclapi', label: 'BMCLAPI', desc: '国内镜像直连，资源与依赖库的下载速度通常快一个量级' }
]

function NetworkSection({
  config,
  patch
}: {
  config: AppConfig
  patch(p: Partial<AppConfig>): void
}): ReactElement {
  return (
    <>
      <Card title="下载源">
        {MIRRORS.map((m) => (
          <button
            key={m.key}
            className={`opt-row ${config.mirror === m.key ? 'on' : ''}`}
            onClick={() => patch({ mirror: m.key })}
          >
            <span className="mark" />
            <span className="txt">
              <span className="t">
                {m.label}
                {m.tag ? <span className="badge accent">{m.tag}</span> : null}
              </span>
              <span className="d">{m.desc}</span>
            </span>
          </button>
        ))}
      </Card>

      <Card title="连接" hint="改完立即对新任务生效">
        <Row
          title="并发下载"
          desc="资源对象是大量小文件，瓶颈在往返延迟而不是带宽；并发太高会被镜像限速"
          control={
            <Seg
              value={config.concurrency}
              options={[4, 8, 12, 16].map((n) => ({ v: n, label: String(n) }))}
              onChange={(v) => patch({ concurrency: v })}
            />
          }
        />
        <Row
          title="单个文件重试次数"
          desc="在主源与镜像之间轮转重试，连续失败三次会熔断该源，避免每个文件都先撞一次墙"
          control={
            <Seg
              value={config.downloadRetries}
              options={[2, 3, 5].map((n) => ({ v: n, label: `${n} 次` }))}
              onChange={(v) => patch({ downloadRetries: v })}
            />
          }
        />
        <Row
          title="单文件超时"
          desc="超过这个时间没有收到数据就判定失败并换源；网络抖动频繁时可以调大"
          control={
            <Seg
              value={config.downloadTimeoutSec}
              options={[15, 30, 60].map((n) => ({ v: n, label: `${n} 秒` }))}
              onChange={(v) => patch({ downloadTimeoutSec: v })}
            />
          }
        />
      </Card>

      <Card title="受管 Java 的来源">
        <div className="set-field" style={{ borderTop: 'none' }}>
          <div className="d">
            Java 运行时优先从清华 TUNA 的 Adoptium 镜像下载，失败再回落 Adoptium 官方。
            受管运行时按大版本分目录保存，多个实例共用一个，不会重复占用空间。
          </div>
        </div>
      </Card>
    </>
  )
}

/* ------------------------------------------------------------ 存储 */

function StorageSection({
  paths,
  usage,
  scanning,
  onScan,
  notify,
  onLogsCleared
}: {
  paths: { root: string; portable: boolean; fallbackReason?: string } | null
  usage: StorageUsage | null
  scanning: boolean
  onScan(force: boolean): Promise<void>
  notify(kind: 'info' | 'success' | 'warn' | 'error', title: string, body?: string): void
  onLogsCleared(): void
}): ReactElement {
  const total = usage?.total ?? 0
  const root = paths?.root ?? ''

  return (
    <>
      {paths?.fallbackReason ? (
        <Card title="数据目录已回落" tint>
          <div className="set-field" style={{ borderTop: 'none' }}>
            <div className="d" style={{ color: 'var(--warn)' }}>{paths.fallbackReason}</div>
            <div className="d" style={{ marginTop: 6 }}>
              想恢复成绿色版，把 exe 挪到有写权限的目录（例如桌面或 U 盘根目录）再启动即可。
            </div>
          </div>
        </Card>
      ) : null}

      <Card
        title="数据目录"
        hint={paths?.portable ? '与 exe 同目录 · 绿色版' : '用户目录'}
      >
        <div className="set-field" style={{ borderTop: 'none' }}>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: 'var(--text-2)',
              wordBreak: 'break-all',
              userSelect: 'text',
              lineHeight: 1.7
            }}
          >
            {root || '—'}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button
              className="btn ghost sm"
              onClick={() => {
                if (root) void window.nova.system.openPath(root)
              }}
            >
              <Icon name="folder" size={12} />
              打开目录
            </button>
            <button className="btn ghost sm" onClick={() => void onScan(true)} disabled={scanning}>
              <Icon name="refresh" size={12} className={scanning ? 'spin' : undefined} />
              {scanning ? '统计中…' : '重新统计'}
            </button>
          </div>
        </div>
      </Card>

      <Card title="占用分布" hint={usage ? `合计 ${fmtBytes(total)}` : scanning ? '统计中…' : ''}>
        {!usage ? (
          <div className="settings-empty">{scanning ? '正在遍历目录…' : '点上面的「重新统计」开始扫描'}</div>
        ) : (
          usage.slices.map((s) => (
            <div key={s.key} className={`usage-row ${s.key === usage.slices[0]?.key && s.bytes > 0 ? 'lead' : ''}`}>
              <div className="top">
                <span className="n">{s.label}</span>
                <span className="sz">
                  {fmtBytes(s.bytes)}
                  <i>{s.files ? `${s.files} 个文件` : ''}</i>
                </span>
              </div>
              <div className="usage-bar">
                <i style={{ width: `${total ? Math.max(1.5, (s.bytes / total) * 100) : 0}%` }} />
              </div>
            </div>
          ))
        )}
        <div className="set-foot">
          <span className="hint">数据在本地，不上传；迁移时整个目录拷走即可</span>
          <span className="acts">
            <button
              className="btn ghost sm"
              onClick={async () => {
                const removed = await invoke(() => window.nova.system.clearLogs(), '清理日志失败')
                if (removed === null) return
                notify(removed ? 'success' : 'info', removed ? `已清理 ${removed} 个日志文件` : '没有可清理的日志')
                onLogsCleared()
              }}
            >
              <Icon name="trash" size={12} />
              清理日志
            </button>
          </span>
        </div>
      </Card>
    </>
  )
}

/* ------------------------------------------------------------ 关于 */

function AboutSection({
  info,
  logs,
  notify,
  config
}: {
  info: SystemInfo | null
  logs: string[]
  notify(kind: 'info' | 'success' | 'warn' | 'error', title: string, body?: string): void
  config: AppConfig
}): ReactElement {
  const [confirming, setConfirming] = useState(false)
  const [checking, setChecking] = useState(false)

  const resetAll = async (): Promise<void> => {
    const next = await invoke(() => window.nova.config.reset(), '恢复默认失败')
    setConfirming(false)
    if (next) {
      await useApp.getState().reload()
      notify('success', '已恢复全部默认设置')
    }
  }

  const checkUpdate = async (): Promise<void> => {
    setChecking(true)
    const r = await invoke(() => window.nova.update.check(), '检查更新失败')
    setChecking(false)
    if (!r) return
    // 通知 App 层全局更新状态（标题栏加号 + 更新弹窗由 App 统一处理）
    window.dispatchEvent(new CustomEvent('nova:update-checked', { detail: r }))
    if (!r.hasUpdate) {
      notify('success', '已经是最新版本', `当前 ${r.currentVersion}`)
    }
  }

  const recent = logs.slice(-4).reverse()
  const accentLabel = ACCENTS.find((a) => a.key === config.accent)?.label ?? config.accent

  return (
    <>
      <Card title="版本信息">
        <div className="kv">
          <dt>NovaMC</dt>
          <dd className="mono">{info?.appVersion ?? __APP_VERSION__}</dd>
          <dt>Electron</dt>
          <dd className="mono">{info?.electron ?? '—'}</dd>
          <dt>Chromium</dt>
          <dd className="mono">{info?.chrome ?? '—'}</dd>
          <dt>Node</dt>
          <dd className="mono">{info?.node ?? '—'}</dd>
          <dt>运行平台</dt>
          <dd>{info ? `${info.platform} · ${info.arch}` : '—'}</dd>
          <dt>版本清单</dt>
          <dd className="mono">piston-meta.mojang.com</dd>
        </div>
        <div className="set-foot">
          <span className="hint">检查 GitHub Releases 上的新版本</span>
          <span className="acts">
            <button className="btn ghost sm" disabled={checking} onClick={() => void checkUpdate()}>
              <Icon name="refresh" size={12} className={checking ? 'spin' : ''} />
              {checking ? '检查中…' : '检查更新'}
            </button>
            <button className="btn ghost sm" onClick={() => void window.nova.update.openReleases()}>
              更新记录
            </button>
          </span>
        </div>
      </Card>

      <Card title="开源" hint="项目源码与更新源">
        <div className="oss-links">
          <button
            className="oss-link primary"
            onClick={() => void window.nova.update.openSource()}
          >
            <Icon name="github" size={16} />
            <span className="oss-link-t">
              <b>GitHub 开源仓库</b>
              <em>源码 · 问题反馈 · 参与贡献</em>
            </span>
            <Icon name="link" size={13} />
          </button>
        </div>
        <div className="set-foot">
          <span className="hint">NovaMC 是一个开源的 Minecraft 启动器，欢迎 Star 与贡献</span>
        </div>
      </Card>

      <Card title="日志" hint={`${logs.length} 个文件`}>
        {recent.length === 0 ? (
          <div className="settings-empty">还没有生成日志文件，启动一次游戏后再来看</div>
        ) : (
          recent.map((file) => {
            const name = file.split(/[\\/]/).pop() ?? file
            return (
              <button
                key={file}
                className="log-file"
                onClick={() => void window.nova.system.openPath(file)}
                title={file}
              >
                <Icon name="file" size={12} style={{ color: 'var(--text-3)' }} />
                <span className="fn">{name}</span>
                <span className="tm">打开</span>
              </button>
            )
          })
        )}
        <div className="set-foot">
          <span className="hint">游戏退出码非 0 时，最后几行会直接弹在右下角</span>
          <span className="acts">
            <button
              className="btn ghost sm"
              onClick={async () => {
                if (!logs.length) {
                  notify('info', '暂无日志文件')
                  return
                }
                await window.nova.system.openPath(logs[logs.length - 1])
              }}
            >
              打开最新日志
            </button>
          </span>
        </div>
      </Card>

      <Card title="危险操作">
        <Row
          title="恢复全部默认设置"
          desc="主题、内存、下载源等全部回到初始值；已探测的 Java 与账号不受影响"
          control={
            confirming ? (
              <>
                <button className="btn ghost sm" onClick={() => setConfirming(false)}>
                  取消
                </button>
                <button className="btn danger sm" onClick={() => void resetAll()}>
                  确认恢复
                </button>
              </>
            ) : (
              <button className="btn ghost sm" onClick={() => setConfirming(true)}>
                恢复默认
              </button>
            )
          }
        />
        <div className="set-foot">
          <span className="hint">
            当前：{THEME_LABEL[config.theme]} · {DENSITY_LABEL[config.density]} · {accentLabel} ·{' '}
            {MIRROR_LABEL[config.mirror]}源 · 并发 {config.concurrency}
          </span>
        </div>
      </Card>
    </>
  )
}
