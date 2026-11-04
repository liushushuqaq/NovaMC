import { useEffect, useMemo, useState } from 'react'
import { useApp, invoke } from '../store'
import { Icon } from '../icons'
import { Modal, Empty, relTime } from '../components'
import { coverStyle, loaderLabel } from './HomePage'
import type {
  ImportProgress,
  ImportStage,
  InstanceConfig,
  LoaderKind,
  MissingDependency,
  ModDependencyReport,
  ModFile,
  PackFormat,
  PackManifest,
  ResPackFile
} from '@core/types'
import type { ReactElement } from 'react'

export default function InstancesPage(): ReactElement {
  const instances = useApp((s) => s.instances)
  const installed = useApp((s) => s.installed)
  const running = useApp((s) => s.running)
  const reload = useApp((s) => s.reload)
  const notify = useApp((s) => s.notify)

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<InstanceConfig | null>(null)
  const [deleting, setDeleting] = useState<InstanceConfig | null>(null)
  const [modsFor, setModsFor] = useState<InstanceConfig | null>(null)
  const [packsFor, setPacksFor] = useState<InstanceConfig | null>(null)

  // 本地整合包导入：先解析出清单给用户确认，再真正开装
  const [packPreview, setPackPreview] = useState<PackManifest | null>(null)
  // 已经在导入的实例：弹窗切成进度态，关掉也能从卡片再打开
  const [importView, setImportView] = useState<InstanceConfig | null>(null)
  const imports = useApp((s) => s.imports)
  const backgrounds = useApp((s) => s.backgrounds)

  // 新建实例只能选本机已经装好的版本：选一个没装的，创建时又要等一遍下载，
  // 用户根本分不清是在"建实例"还是在"装版本"
  const baseVersions = useMemo(
    () =>
      installed
        .filter((v) => v.complete && v.hasJar)
        .map((v) => v.id)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
    [installed]
  )

  /** 选一个整合包 zip，解析清单后弹确认框 */
  const pickPack = async (): Promise<void> => {
    const pack = await invoke(() => window.nova.modpack.pickZip(), '读取整合包失败')
    if (pack) setPackPreview(pack)
  }

  /**
   * 真正开装：主进程先把「导入中」的实例建好再返回，剩下的下载在后台跑。
   * 所以这里拿到实例就立刻把弹窗切成进度态，玩家不用干等。
   */
  const confirmImport = async (): Promise<void> => {
    if (!packPreview) return
    const zipPath = packPreview.zipPath
    const inst = await invoke(() => window.nova.modpack.importZip(zipPath), '导入整合包失败')
    if (!inst) return
    setPackPreview(null)
    setImportView(inst)
    await reload()
  }

  /** 取消导入：主进程会中止任务并删掉半成品目录 */
  const cancelImport = async (inst: InstanceConfig): Promise<void> => {
    const res = await window.nova.modpack.cancelImport(inst.id)
    if (!res.ok) {
      notify('error', '取消导入失败', res.message)
      return
    }
    setImportView((cur) => (cur?.id === inst.id ? null : cur))
    await reload()
  }

  const retryImport = async (inst: InstanceConfig): Promise<void> => {
    const next = await invoke(() => window.nova.modpack.retryImport(inst.id), '重试导入失败')
    if (!next) return
    setImportView(next)
    await reload()
  }

  const launch = async (inst: InstanceConfig): Promise<void> => {
    const res = await invoke(() => window.nova.launch.start(inst.id), `启动 ${inst.name} 失败`)
    if (res) {
      useApp.setState({ running: inst.id })
      await reload()
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>实例</h1>
          <div className="sub">
            {instances.length} 个实例 · 每个实例有独立的 Java、内存与模组目录
          </div>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => void pickPack()}>
            <Icon name="download" size={14} />
            导入整合包
          </button>
          <button className="btn primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={14} />
            新建实例
          </button>
        </div>
      </div>

      <div className="section">
        {instances.length === 0 ? (
          <Empty
            title={baseVersions.length ? '还没有实例' : '还没有可用的游戏版本'}
            hint={
              baseVersions.length
                ? '新建实例会自动下载对应的游戏版本与依赖'
                : '先去「版本管理」装一个游戏版本，再回来建实例'
            }
          />
        ) : (
          <div className="instance-grid">
            {instances.map((inst) => {
              // 正在导入 / 导入中断的实例走另一套卡片：不能启动，只能看进度或重试
              const imp = importStateOf(inst, imports[inst.id])
              if (imp) {
                return (
                  <ImportCard
                    key={inst.id}
                    inst={inst}
                    view={imp}
                    onOpen={() => setImportView(inst)}
                    onCancel={() => void cancelImport(inst)}
                    onRetry={() => void retryImport(inst)}
                    onDelete={() => setDeleting(inst)}
                  />
                )
              }
              return (
                <div key={inst.id} className="instance-card">
                  <div className="cover" style={coverStyle(inst.slug, backgrounds[inst.id])}>
                    {running === inst.id ? (
                      <span className="tag badge accent">
                        <i className="dot" />
                        运行中
                      </span>
                    ) : null}
                  </div>
                  <div className="info">
                    <b>{inst.name}</b>
                    <span className="m">
                      {inst.gameVersion} · {loaderLabel(inst)}
                    </span>
                    <span className="s">
                      {inst.memory.maxMb} MB · {relTime(inst.lastPlayedAt)}
                      {inst.source ? ` · ${inst.source.provider}` : ''}
                    </span>
                  </div>
                  <div className="foot">
                    <button className="btn sm primary" onClick={() => void launch(inst)} disabled={running === inst.id}>
                      <Icon name="play" size={11} />
                      启动
                    </button>
                    <button className="btn sm ghost" onClick={() => setEditing(inst)}>
                      <Icon name="edit" size={11} />
                      设置
                    </button>
                    <button className="btn sm ghost" onClick={() => setModsFor(inst)}>
                      <Icon name="package" size={11} />
                      模组
                    </button>
                    {packKinds(inst).length > 0 ? (
                      <button className="btn sm ghost" onClick={() => setPacksFor(inst)}>
                        <Icon name="palette" size={11} />
                        光影/材质包
                      </button>
                    ) : null}
                    <button className="btn sm danger" onClick={() => setDeleting(inst)}>
                      <Icon name="trash" size={11} />
                    </button>
                  </div>
                </div>
              )
            })}

            <button className="create-card" onClick={() => setCreateOpen(true)}>
              <div style={{ fontSize: 26, lineHeight: 1 }}>+</div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>新建实例</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)' }}>选择版本、加载器与内存</div>
            </button>
          </div>
        )}
      </div>

      {createOpen ? (
        <CreateModal
          versions={baseVersions}
          onClose={() => setCreateOpen(false)}
          onDone={async () => {
            setCreateOpen(false)
            await reload()
          }}
        />
      ) : null}

      {editing ? (
        <EditModal
          instance={editing}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null)
            await reload()
          }}
        />
      ) : null}

      {packPreview ? (
        <Modal
          title={`导入「${packPreview.name}」`}
          desc="按包里的清单补齐缺的游戏版本、模组加载器和模组，装完直接能启动。"
          onClose={() => setPackPreview(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setPackPreview(null)}>
                取消
              </button>
              <button className="btn primary" onClick={() => void confirmImport()}>
                开始导入
              </button>
            </>
          }
        >
          <div className="col" style={{ gap: 8 }}>
            <PackRow label="来源格式" value={packFormatLabel(packPreview.format)} />
            <PackRow
              label="游戏版本"
              value={packPreview.minecraft ? `${packPreview.minecraft}（未安装会自动下载）` : '包里没有声明'}
            />
            <PackRow
              label="模组加载器"
              value={
                packPreview.loader
                  ? `${packPreview.loader.kind} ${packPreview.loader.version}`
                  : '没识别出来'
              }
            />
            <PackRow label="需要下载" value={`${packPreview.files.length} 个模组`} />
            <PackRow label="包内自带" value={`${packPreview.bundledMods} 个 jar + 配置/资源`} />
            <PackRow
              label="建议内存"
              value={packPreview.recommendedRamMb ? `${packPreview.recommendedRamMb} MB` : '默认 8 GB'}
            />
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.7 }}>
            点「开始导入」后会先建好实例，进度实时显示；关掉这个窗口也会继续下载，实例卡片上看得到。
          </div>
        </Modal>
      ) : null}

      {importView ? (
        <ImportPanel
          instance={importView}
          onClose={() => setImportView(null)}
          onCancel={() => void cancelImport(importView)}
          onRetry={() => void retryImport(importView)}
        />
      ) : null}

      {deleting ? (
        <Modal
          title={`删除实例「${deleting.name}」`}
          desc="实例目录（含模组、存档、配置）会被一并删除，此操作不可撤销。"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await invoke(() => window.nova.instances.remove(deleting.id), '删除失败')
                  setDeleting(null)
                  await reload()
                  notify('success', '实例已删除')
                }}
              >
                确认删除
              </button>
            </>
          }
        >
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            游戏版本 {deleting.gameVersion} · {loaderLabel(deleting)}
          </div>
        </Modal>
      ) : null}

      {modsFor ? <ModsModal instance={modsFor} onClose={() => setModsFor(null)} /> : null}
      {packsFor ? <ResourcePacksModal instance={packsFor} onClose={() => setPacksFor(null)} /> : null}
    </>
  )
}

/* ---------------------------------------------------------------- 导入 */

const IMPORT_STAGES: { key: Exclude<ImportStage, 'done'>; label: string; hint: string }[] = [
  { key: 'parse', label: '读取整合包清单', hint: '版本、加载器、要下哪些模组' },
  { key: 'version', label: '补齐游戏版本', hint: '没装过就自动下原版与依赖库' },
  { key: 'loader', label: '安装模组加载器', hint: 'Fabric / Forge / NeoForge' },
  { key: 'mods', label: '下载模组文件', hint: '几百个模组走 CDN 并发下载' },
  { key: 'overrides', label: '展开配置与资源', hint: '包里自带的配置、资源包与光影' }
]

interface ImportView {
  kind: 'running' | 'failed' | 'done'
  stage: ImportStage
  label: string
  percent: number
  done: number
  total: number
  error?: string
}

/** 落盘的导入状态 + 实时进度事件 → 一份界面能直接用的视图 */
function importStateOf(inst: InstanceConfig, live?: ImportProgress): ImportView | null {
  const saved = inst.importState
  if (!saved) return null

  if (saved.status === 'importing' && live && live.stage !== 'done') {
    return {
      kind: 'running',
      stage: live.stage,
      label: live.label,
      percent: live.percent,
      done: live.done,
      total: live.total
    }
  }
  if (saved.status === 'importing') {
    return {
      kind: 'running',
      stage: saved.stage,
      label: saved.label,
      percent: saved.percent,
      done: saved.done,
      total: saved.total
    }
  }
  return {
    kind: 'failed',
    stage: saved.stage,
    label: saved.label,
    percent: saved.percent,
    done: saved.done,
    total: saved.total,
    error: saved.error ?? (saved.status === 'interrupted' ? '启动器退出时导入被打断了' : '导入没有跑完')
  }
}

/** 进度事件里已经收尾的那一条（此时 instance.json 里的 importState 已经清掉了） */
function importViewFromEvent(live?: ImportProgress): ImportView | null {
  if (!live || live.stage !== 'done' || live.cancelled) return null
  if (live.error) {
    return { kind: 'failed', stage: 'parse', label: '导入失败', percent: 0, done: 0, total: 0, error: live.error }
  }
  return { kind: 'done', stage: 'done', label: live.label, percent: 1, done: 1, total: 1 }
}

function stageIndexOf(stage: ImportStage): number {
  const i = IMPORT_STAGES.findIndex((s) => s.key === stage)
  return i < 0 ? IMPORT_STAGES.length : i
}

/** 导入中的实例卡：不能启动，只能看进度或取消 */
function ImportCard({
  inst,
  view,
  onOpen,
  onCancel,
  onRetry,
  onDelete
}: {
  inst: InstanceConfig
  view: ImportView
  onOpen(): void
  onCancel(): void
  onRetry(): void
  onDelete(): void
}): ReactElement {
  const running = view.kind === 'running'
  const pct = Math.max(0, Math.min(1, view.percent))

  return (
    <div className={`instance-card ${running ? 'is-importing' : 'is-failed'}`}>
      <div className={`cover imp-cover ${running ? '' : 'failed'}`}>
        {running ? <div className="imp-shimmer" /> : null}
        <span className={`tag badge ${running ? 'accent' : 'danger'}`}>
          <i className={`dot ${running ? 'imp-pulse' : ''}`} />
          {running ? '导入中' : '导入中断'}
        </span>
        {running ? (
          <div className="imp-counter">
            <b>{Math.round(pct * 100)}</b>
            <span>%</span>
          </div>
        ) : (
          <div className="imp-failed-mark">
            <Icon name="warning" size={20} />
          </div>
        )}
        {running ? (
          <div className="imp-track">
            <i style={{ width: `${Math.max(3, pct * 100)}%` }} />
          </div>
        ) : null}
      </div>
      <div className="info">
        <b>{inst.name}</b>
        <span className="m imp-ellipsis">
          {running ? view.label : (view.error ?? '导入没有跑完')}
        </span>
        <span className="s">
          {inst.gameVersion} · {loaderLabel(inst)}
        </span>
      </div>
      <div className="foot">
        {running ? (
          <>
            <button className="btn sm ghost" onClick={onOpen}>
              <Icon name="download" size={11} />
              查看进度
            </button>
            <button className="btn sm danger" onClick={onCancel}>
              取消
            </button>
          </>
        ) : (
          <>
            <button className="btn sm primary" onClick={onRetry}>
              <Icon name="refresh" size={11} />
              重试
            </button>
            <button className="btn sm ghost" onClick={onOpen}>
              详情
            </button>
            <button className="btn sm danger" onClick={onDelete}>
              <Icon name="trash" size={11} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** 导入面板：进度环 + 五段轨道 + 当前文件；可以关掉让它后台跑 */
function ImportPanel({
  instance,
  onClose,
  onCancel,
  onRetry
}: {
  instance: InstanceConfig
  onClose(): void
  onCancel(): void
  onRetry(): void
}): ReactElement {
  const live = useApp((s) => s.imports[instance.id])
  // 实例列表会随 reload 更新，这里每次都取最新的那份
  const fresh = useApp((s) => s.instances.find((i) => i.id === instance.id)) ?? instance
  const [confirmCancel, setConfirmCancel] = useState(false)

  const view = importStateOf(fresh, live) ?? importViewFromEvent(live)
  const running = view?.kind === 'running'
  const failed = view?.kind === 'failed'
  const done = view?.kind === 'done'
  const pct = done ? 1 : Math.max(0, Math.min(1, view?.percent ?? 0))
  const R = 2 * Math.PI * 52

  const title = failed ? `导入中断「${fresh.name}」` : done ? `导入完成「${fresh.name}」` : `正在导入「${fresh.name}」`
  const desc = failed
    ? '已经下载的文件保留在实例目录里，点「重试」会接着补，不会从头再来。'
    : done
      ? '实例已经可以启动了，背景图和模组都在实例目录里。'
      : '进度会一直留在这张卡片上。关掉这个窗口就是后台运行，随时可以再点「查看进度」回来。'

  return (
    <Modal
      title={title}
      desc={desc}
      wide
      onClose={onClose}
      footer={
        failed ? (
          <>
            <button className="btn ghost" onClick={onCancel}>
              删除实例
            </button>
            <button className="btn primary" onClick={onRetry}>
              <Icon name="refresh" size={13} />
              重试
            </button>
          </>
        ) : done ? (
          <button className="btn primary" onClick={onClose}>
            好的
          </button>
        ) : confirmCancel ? (
          <>
            <span style={{ fontSize: 11, color: 'var(--danger)', marginRight: 'auto' }}>
              取消会删掉已经下好的文件
            </span>
            <button className="btn ghost" onClick={() => setConfirmCancel(false)}>
              算了
            </button>
            <button className="btn danger" onClick={onCancel}>
              确定取消
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={() => setConfirmCancel(true)}>
              取消导入
            </button>
            <button className="btn primary" onClick={onClose}>
              后台继续
            </button>
          </>
        )
      }
    >
      <div className="imp-head">
        <div className={`imp-ring ${running ? 'live' : failed ? 'bad' : 'ok'}`}>
          <svg viewBox="0 0 120 120">
            <circle className="ring-track" cx="60" cy="60" r="52" />
            <circle
              className="ring-bar"
              cx="60"
              cy="60"
              r="52"
              style={{ strokeDasharray: R, strokeDashoffset: R * (1 - pct) }}
            />
          </svg>
          <div className="imp-ring-text">
            <b>{done ? 100 : Math.round(pct * 100)}</b>
            <span>%</span>
          </div>
        </div>

        <div className="imp-head-info">
          <div className="imp-headline">
            {failed ? '这次没装完' : done ? '全部完成' : (IMPORT_STAGES[stageIndexOf(view?.stage ?? 'parse')]?.label ?? '准备中')}
          </div>
          <div className={`imp-label ${running ? 'live' : ''}`}>
            <i className="dot" />
            <span className="imp-ellipsis">{view?.label ?? '准备导入'}</span>
          </div>
          <div className="imp-figures">
            {view && view.total > 0 ? (
              <span>
                {view.done} / {view.total}
              </span>
            ) : null}
            {failed && view?.error ? <span className="imp-err">{view.error}</span> : null}
          </div>
        </div>
      </div>

      <div className="imp-stages">
        {IMPORT_STAGES.map((s, i) => {
          const cur = stageIndexOf(view?.stage ?? 'parse')
          const state =
            done || i < cur ? 'done' : i === cur ? (failed ? 'failed' : running ? 'active' : 'todo') : 'todo'
          return (
            <div key={s.key} className={`imp-stage ${state}`}>
              <div className="imp-step">
                {state === 'done' ? <Icon name="check" size={11} /> : <span>{i + 1}</span>}
              </div>
              <div className="imp-stage-body">
                <b>{s.label}</b>
                <span className="imp-ellipsis">
                  {state === 'active' && view ? view.label : s.hint}
                </span>
              </div>
              <span className="imp-stage-state">
                {state === 'done' ? '完成' : state === 'active' ? '进行中' : state === 'failed' ? '中断' : '等待'}
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

/**
 * 导入预览里的一行「标签 —— 值」。
 */
function PackRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontSize: 11.5 }}>
      <span style={{ width: 72, flexShrink: 0, color: 'var(--text-3)' }}>{label}</span>
      <span style={{ color: 'var(--text-1)', wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
}

function packFormatLabel(format: PackFormat): string {
  if (format === 'curseforge') return 'CurseForge 导出包'
  if (format === 'modrinth') return 'Modrinth 整合包'
  return '普通 .minecraft 压缩包'
}

/**
 * 判断实例支持哪些资源包类别。
 * - 材质包（resourcepacks）：几乎都支持（原版 / Fabric / Forge / NeoForge / Quilt 都加载资源包）
 * - 光影包（shaderpacks）：需要 OptiFine 或 Iris，而这两个都能通过「一键安装光影支持」装上
 *
 * 现在所有加载器都有对应的光影方案（Fabric/NeoForge→Iris，Forge/原版→OptiFine），
 * 所以材质包 + 光影两个 Tab 全显示；后续若加了不支持光影的加载器再收紧。
 */
function packKinds(inst: InstanceConfig): Array<'shader' | 'resource'> {
  const kinds: Array<'shader' | 'resource'> = ['resource']
  // 所有已知加载器都支持光影（OptiFine 或 Iris），保留未来扩展余地
  kinds.push('shader')
  return kinds
}

function CreateModal({
  versions,
  onClose,
  onDone
}: {
  versions: string[]
  onClose(): void
  onDone(): Promise<void>
}): ReactElement {
  const config = useApp((s) => s.config)
  const notify = useApp((s) => s.notify)
  const setPage = useApp((s) => s.setPage)

  const [name, setName] = useState('')
  const [gameVersion, setGameVersion] = useState(versions[0] ?? '')
  const [loader, setLoader] = useState<LoaderKind>('vanilla')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loaderList, setLoaderList] = useState<{ id: string; prerelease: boolean }[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [maxMb, setMaxMb] = useState(config?.defaultMemory.maxMb ?? 8192)
  const [busy, setBusy] = useState(false)
  const [shaderWanted, setShaderWanted] = useState(false)
  const noVersion = versions.length === 0

  // 选了 forge / neoforge 时拉取可用版本列表
  const pickLoader = async (kind: LoaderKind): Promise<void> => {
    setLoader(kind)
    setLoaderVersion('')
    if (kind === 'forge' || kind === 'neoforge') {
      setLoadingList(true)
      const list = await invoke(
        () => window.nova.versions.listForge(kind, gameVersion),
        `拉取 ${kind === 'forge' ? 'Forge' : 'NeoForge'} 版本失败`
      )
      setLoadingList(false)
      const stable = (list ?? []).filter((v) => !v.prerelease)
      setLoaderList(stable.length ? stable : list ?? [])
      if ((stable.length ? stable : list ?? []).length) {
        setLoaderVersion((stable.length ? stable : list!)[0].id)
      }
    } else {
      setLoaderList([])
    }
  }

  const submit = async (): Promise<void> => {
    if (noVersion) return
    if (!name.trim()) {
      notify('warn', '请填写实例名称')
      return
    }
    if ((loader === 'forge' || loader === 'neoforge') && !loaderVersion) {
      notify('warn', '请先选择一个加载器版本')
      return
    }
    setBusy(true)
    try {
      let versionId = gameVersion
      let loaderInfo: InstanceConfig['loader'] = { kind: 'vanilla' }
      if (loader === 'fabric') {
        const fabric = await invoke(
          () => window.nova.versions.installFabric(gameVersion),
          '安装 Fabric 失败'
        )
        if (!fabric) return
        versionId = fabric.versionId
        loaderInfo = { kind: 'fabric', version: fabric.loaderVersion }
      } else if (loader === 'forge' || loader === 'neoforge') {
        const forge = await invoke(
          () => window.nova.versions.installForge(loader, loaderVersion),
          `安装 ${loader === 'forge' ? 'Forge' : 'NeoForge'} 失败`
        )
        if (!forge) return
        versionId = forge.versionId
        loaderInfo = { kind: loader, version: loaderVersion }
      }
      const created = await invoke(
        () =>
          window.nova.instances.create({
            name: name.trim(),
            gameVersion,
            versionId,
            loader: loaderInfo,
            memory: { minMb: Math.min(2048, maxMb), maxMb }
          }),
        '创建实例失败'
      )
      if (created) {
        await window.nova.config.patch({ lastInstanceId: created.id })
        // 勾了「安装光影支持」就顺带把 Iris/Sodium/OptiFine 装好，建完直接能用
        if (shaderWanted) {
          const shaderRes = await invoke(() => window.nova.shader.install(created.id), '安装光影支持失败')
          if (shaderRes) {
            if (shaderRes.ready) {
              notify('success', '光影支持已就绪', `${shaderRes.installed.join('、')} · 进游戏后到 视频设置 → 光影 里选包`)
            }
            if (shaderRes.failed.length) {
              notify(
                'warn',
                '部分光影组件没装上',
                shaderRes.failed.map((f) => `${f.slug}：${f.message}`).join('\n')
              )
            }
          }
        }
        notify('success', '实例已创建', `${created.name} 已就绪`)
        await onDone()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="新建实例"
      desc="游戏版本只能从本机已安装的版本里选；存档与模组按实例独立存放"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || noVersion}>
            {busy ? '处理中…' : '创建'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>实例名称</label>
        <input
          className="input"
          autoFocus
          placeholder="例如：All the Mods 10"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>游戏版本</label>
          {noVersion ? (
            <div className="col" style={{ gap: 8 }}>
              <div
                className="input"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 'auto',
                  padding: '10px 11px',
                  color: 'var(--text-3)',
                  cursor: 'default'
                }}
              >
                本机还没有安装任何游戏版本
              </div>
              <button
                className="btn ghost sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  onClose()
                  setPage('versions')
                }}
              >
                去「版本管理」安装
              </button>
            </div>
          ) : (
            <>
              <select className="select" value={gameVersion} onChange={(e) => setGameVersion(e.target.value)}>
                {versions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                仅列出本机已装完的 {versions.length} 个版本
              </span>
            </>
          )}
        </div>
        <div className="field">
          <label>模组加载器</label>
          <select
            className="select"
            value={loader}
            disabled={noVersion}
            onChange={(e) => void pickLoader(e.target.value as LoaderKind)}
          >
            <option value="vanilla">Vanilla（原版）</option>
            <option value="fabric">Fabric（自动取最新稳定版）</option>
            <option value="forge">Forge</option>
            <option value="neoforge">NeoForge</option>
          </select>
          {loader === 'fabric' ? (
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>创建时会联网拉取 Fabric 加载器</span>
          ) : null}
          {loader === 'forge' || loader === 'neoforge' ? (
            loadingList ? (
              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>正在拉取版本列表…</span>
            ) : (
              <>
                <select
                  className="select"
                  style={{ marginTop: 8 }}
                  value={loaderVersion}
                  onChange={(e) => setLoaderVersion(e.target.value)}
                >
                  {loaderList.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.id}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                  安装会下载安装包并执行处理器，比 Fabric 慢一些
                </span>
              </>
            )
          ) : null}
        </div>
      </div>

      <div className="field">
        <label>光影支持</label>
        {loader === 'vanilla' ? (
          <span style={{ fontSize: 10, color: 'var(--text-3)', lineHeight: 1.7 }}>
            原版客户端不加载 mods 目录，光影包放进去也不会生效。想要光影请选 Fabric（Iris）或 Forge（OptiFine）。
          </span>
        ) : (
          <>
            <label className="check" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={shaderWanted}
                onChange={(e) => setShaderWanted(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                安装光影支持（{loader === 'forge' ? 'OptiFine' : 'Iris + Sodium'}）
              </span>
            </label>
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
              勾选后创建实例时会自动下载并装好光影模组，装完进游戏即可在视频设置里开光影
            </span>
          </>
        )}
      </div>

      <div className="field">
        <label>最大内存 {maxMb} MB</label>
        <input
          type="range"
          min={1024}
          max={16384}
          step={512}
          value={maxMb}
          onChange={(e) => setMaxMb(Number(e.target.value))}
        />
        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
          大型整合包建议 8192 MB 以上；留一半内存给系统
        </span>
      </div>
    </Modal>
  )
}

function EditModal({
  instance,
  onClose,
  onDone
}: {
  instance: InstanceConfig
  onClose(): void
  onDone(): Promise<void>
}): ReactElement {
  const reload = useApp((s) => s.reload)
  const notify = useApp((s) => s.notify)
  const [name, setName] = useState(instance.name)
  const [maxMb, setMaxMb] = useState(instance.memory.maxMb)
  const [width, setWidth] = useState(instance.window.width)
  const [height, setHeight] = useState(instance.window.height)
  const [fullscreen, setFullscreen] = useState(instance.window.fullscreen)
  const [javaPath, setJavaPath] = useState(instance.java.path ?? '')
  const [jvmArgs, setJvmArgs] = useState(instance.jvmArgs.join('\n'))
  const [gameArgs, setGameArgs] = useState(instance.gameArgs.join('\n'))

  const save = async (): Promise<void> => {
    const ok = await invoke(
      () =>
        window.nova.instances.update(instance.id, {
          name,
          memory: { minMb: Math.min(2048, maxMb), maxMb },
          window: { width, height, fullscreen },
          java: javaPath ? { mode: 'custom', path: javaPath } : { mode: 'auto' },
          jvmArgs: jvmArgs.split('\n').map((s) => s.trim()).filter(Boolean),
          gameArgs: gameArgs.split('\n').map((s) => s.trim()).filter(Boolean)
        }),
      '保存失败'
    )
    if (ok) {
      notify('success', '已保存')
      await onDone()
      await reload()
    }
  }

  return (
    <Modal
      title={`实例设置 · ${instance.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      <div className="field-row">
        <div className="field">
          <label>实例名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>游戏版本</label>
          <input className="input" value={`${instance.gameVersion} · ${loaderLabel(instance)}`} disabled />
        </div>
      </div>

      <div className="field">
        <label>最大内存 {maxMb} MB</label>
        <input type="range" min={1024} max={32768} step={512} value={maxMb} onChange={(e) => setMaxMb(Number(e.target.value))} />
      </div>

      <div className="field-row">
        <div className="field">
          <label>窗口宽度</label>
          <input className="input" type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        </div>
        <div className="field">
          <label>窗口高度</label>
          <input className="input" type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} />
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>全屏启动</span>
        <button className={`toggle ${fullscreen ? 'on' : ''}`} onClick={() => setFullscreen((v) => !v)} aria-label="切换全屏" />
      </div>

      <div className="field">
        <label>Java 路径（留空则自动匹配）</label>
        <div className="row">
          <input className="input" value={javaPath} onChange={(e) => setJavaPath(e.target.value)} placeholder="自动选择最合适的运行时" />
          <button
            className="btn ghost"
            onClick={async () => {
              const picked = await invoke(() => window.nova.system.pickJava())
              if (picked) setJavaPath(picked)
            }}
          >
            浏览
          </button>
        </div>
      </div>

      <div className="field">
        <label>额外 JVM 参数（每行一个）</label>
        <textarea
          className="input"
          style={{ height: 68, padding: 8, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
          value={jvmArgs}
          onChange={(e) => setJvmArgs(e.target.value)}
          placeholder="-XX:+UseZGC"
        />
      </div>

      <div className="field">
        <label>额外游戏参数（每行一个）</label>
        <textarea
          className="input"
          style={{ height: 56, padding: 8, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
          value={gameArgs}
          onChange={(e) => setGameArgs(e.target.value)}
          placeholder="--server mc.example.com"
        />
      </div>
    </Modal>
  )
}

/**
 * 版本范围的显示：
 * `*` 单独出现时显示"任意"；和别的条件并存时 `*` 是冗余的，去掉免得看着费解。
 */
function formatRange(dep: MissingDependency): string {
  const ranges = dep.allRanges?.length ? dep.allRanges : [dep.versionRange]
  const strict = ranges.filter((r) => r !== '*')
  if (!strict.length) return '任意'
  return strict.join(' 且 ')
}

function ModsModal({ instance, onClose }: { instance: InstanceConfig; onClose(): void }): ReactElement {
  const [mods, setMods] = useState<ModFile[] | null>(null)
  const [deps, setDeps] = useState<ModDependencyReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  const running = useApp((s) => s.running)
  const notify = useApp((s) => s.notify)

  const load = async (): Promise<void> => {
    const list = await invoke(() => window.nova.instances.mods(instance.id), '读取模组失败')
    setMods(list ?? [])
  }

  const check = async (): Promise<void> => {
    const report = await invoke(() => window.nova.instances.checkDeps(instance.id), '检查模组依赖失败')
    setDeps(report ?? { scanned: 0, missing: [] })
  }

  useEffect(() => {
    void load()
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (file: ModFile): Promise<void> => {
    setBusy(file.fileName)
    await invoke(() => window.nova.instances.toggleMod(instance.id, file.fileName, !file.enabled), '切换失败')
    await load()
    await check()
    setBusy(null)
  }

  const fixDeps = async (): Promise<void> => {
    setFixing(true)
    const res = await invoke(() => window.nova.instances.fixDeps(instance.id), '安装前置模组失败')
    setFixing(false)
    if (res) {
      if (res.installed.length) notify('success', `已安装 ${res.installed.length} 个前置模组`, res.installed.join('、'))
      if (res.failed.length) notify('warn', '有前置模组没装上', res.failed.map((f) => `${f.id}：${f.message}`).join('\n'))
    }
    await load()
    await check()
  }

  const missing = deps?.missing ?? []
  // 版本范围对不上的不算「能一键装」，装上去照样崩
  const autoFixable = missing.filter((m) => m.candidate && !m.candidate.rangeMismatch).length

  return (
    <Modal
      title={`模组 · ${instance.name}`}
      desc={running === instance.id ? '游戏运行中，改动会在下次启动生效' : '停用的模组会重命名为 .jar.disabled'}
      wide
      onClose={onClose}
      footer={
        <>
          <button
            className="btn ghost"
            onClick={async () => {
              const p = await window.nova.system.paths()
              if (p.ok) await window.nova.system.openPath(`${p.data.instances}/${instance.slug}/.minecraft/mods`)
            }}
          >
            <Icon name="folder" size={13} />
            打开 mods 目录
          </button>
          <button className="btn primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      {missing.length ? (
        <div
          style={{
            border: '1px solid var(--warn-border)',
            background: 'var(--warn-soft)',
            borderRadius: 10,
            padding: '11px 13px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}
        >
          <div className="row" style={{ gap: 8 }}>
            <Icon name="warning" size={14} style={{ color: 'var(--warn)' }} />
            <b style={{ fontSize: 11.5, color: 'var(--warn)' }}>
              缺少 {missing.length} 个前置模组，直接启动会在加载阶段崩溃
            </b>
            <div className="grow" />
            {autoFixable ? (
              <button className="btn sm primary" disabled={fixing} onClick={() => void fixDeps()}>
                {fixing ? '安装中…' : `一键安装${autoFixable > 1 ? ` (${autoFixable})` : ''}`}
              </button>
            ) : null}
          </div>
          {missing.map((dep) => (
            <div key={dep.id} style={{ fontSize: 10.5, lineHeight: 1.7, color: 'var(--text-2)' }}>
              <b style={{ color: 'var(--text)' }}>{dep.id}</b>
              <span style={{ color: 'var(--text-3)' }}>
                {' '}· 版本 {formatRange(dep)} · 需要它的：{dep.requiredBy.join('、')}
              </span>
              {dep.candidate ? (
                dep.candidate.rangeMismatch ? (
                  <span style={{ color: 'var(--warn)' }}>
                    {' '}
                    → Modrinth 上没有满足该范围的版本（最高 {dep.candidate.versionNumber}），需要手动处理
                  </span>
                ) : (
                  <span style={{ color: 'var(--accent)' }}>
                    {' '}
                    → 将安装 {dep.candidate.title} {dep.candidate.versionNumber}
                  </span>
                )
              ) : (
                <span style={{ color: 'var(--warn)' }}> → Modrinth 上没有匹配版本，需要手动安装</span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {mods === null ? (
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>读取中…</div>
      ) : mods.length === 0 ? (
        <Empty title="mods 目录是空的" hint="在「整合包」页面安装一个整合包，或手动把 .jar 放进 mods 目录" />
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {mods.map((m) => (
            <div key={m.fileName} className="list-row">
              <Icon name="package" size={15} style={{ color: 'var(--text-3)' }} />
              <div className="grow">
                <b style={{ fontSize: 11.5 }}>{m.fileName.replace(/\.jar(\.disabled)?$/, '')}</b>
                <div className="m">
                  {(m.size / 1024 / 1024).toFixed(2)} MB {m.enabled ? '' : ' · 已停用'}
                </div>
              </div>
              <button className="btn sm ghost" disabled={busy === m.fileName} onClick={() => void toggle(m)}>
                {m.enabled ? '停用' : '启用'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/**
 * 光影 / 材质包管理面板。
 * 两个 Tab 分开：光影（shaderpacks）、材质包（resourcepacks）。
 * 只显示实例实际支持的 Tab——原版只显示材质包，装了模组加载器才显示光影。
 */
function ResourcePacksModal({
  instance,
  onClose
}: {
  instance: InstanceConfig
  onClose(): void
}): ReactElement {
  const kinds = packKinds(instance)
  const [tab, setTab] = useState<'shader' | 'resource'>(kinds[0])
  const [packs, setPacks] = useState<ResPackFile[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [shaderInstalling, setShaderInstalling] = useState(false)
  const [shaderMsg, setShaderMsg] = useState<string | null>(null)
  const [shaderStatus, setShaderStatus] = useState<{ ready: boolean; found: string[] } | null>(null)
  const running = useApp((s) => s.running)
  const notify = useApp((s) => s.notify)

  const load = async (kind: 'shader' | 'resource'): Promise<void> => {
    setPacks(null)
    const list = await invoke(() => window.nova.instances.packages(instance.id, kind), '读取失败')
    setPacks(list ?? [])
  }

  /** mods 里到底有没有 Iris/OptiFine —— 面板每次打开都重新问一次，别让用户猜 */
  const refreshShaderStatus = async (): Promise<void> => {
    const res = await window.nova.shader.status(instance.id)
    setShaderStatus(res.ok ? res.data : null)
  }

  useEffect(() => {
    void load(tab)
    if (tab === 'shader') void refreshShaderStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const toggle = async (file: ResPackFile): Promise<void> => {
    setBusy(file.fileName)
    await invoke(
      () => window.nova.instances.togglePackage(instance.id, tab, file.fileName, !file.enabled),
      '切换失败'
    )
    await load(tab)
    setBusy(null)
  }

  const installShader = async (): Promise<void> => {
    setShaderInstalling(true)
    setShaderMsg(null)
    const res = await invoke(() => window.nova.shader.install(instance.id), '安装光影支持失败')
    setShaderInstalling(false)
    await refreshShaderStatus()
    if (res) {
      if (res.ready) {
        notify('success', '光影支持已就绪', '进游戏后到 视频设置 → 光影 里选包')
      }
      if (res.installed.length) {
        setShaderMsg(`已安装：${res.installed.join('、')}`)
      }
      if (res.failed.length) {
        notify('warn', '部分光影组件没装上', res.failed.map((f) => `${f.slug}：${f.message}`).join('\n'))
        setShaderMsg((prev) => (prev ? `${prev}\n` : '') + `未装上：${res.failed.map((f) => f.slug).join('、')}`)
      }
      if (!res.installed.length && !res.failed.length) {
        setShaderMsg('没有需要安装的组件')
      }
    }
  }

  /** 打开目录：主进程会先把目录建出来，老实例也不会再"找不到路径" */
  const openDir = async (): Promise<void> => {
    const res = await window.nova.instances.openPackDir(instance.id, tab)
    if (!res.ok) notify('error', '打开目录失败', res.message)
  }

  const dirName = tab === 'shader' ? 'shaderpacks' : 'resourcepacks'

  return (
    <Modal
      title={`光影/材质包 · ${instance.name}`}
      desc={running === instance.id ? '游戏运行中，改动会在下次启动生效' : '停用的包会重命名为 .disabled'}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={() => void openDir()}>
            <Icon name="folder" size={13} />
            打开 {dirName} 目录
          </button>
          <button className="btn primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      <div className="tabs" style={{ padding: '0 0 12px', marginBottom: 16 }}>
        {kinds.includes('shader') ? (
          <button className={`tab ${tab === 'shader' ? 'active' : ''}`} onClick={() => setTab('shader')}>
            光影
          </button>
        ) : null}
        {kinds.includes('resource') ? (
          <button className={`tab ${tab === 'resource' ? 'active' : ''}`} onClick={() => setTab('resource')}>
            材质包
          </button>
        ) : null}
      </div>

      {tab === 'shader' ? (
        <>
          {instance.loader.kind === 'vanilla' ? (
            <div className="shader-banner warn">
              <div className="grow">
                <b>原版实例开不了光影</b>
                <span className="shader-sub">
                  原版客户端不加载 mods 目录，OptiFine 的 jar 放进去也不会生效。光影包需要 Iris 或 OptiFine，
                  得用 Fabric / Forge 实例——新建实例时选这两个加载器即可。
                </span>
              </div>
            </div>
          ) : shaderStatus?.ready ? (
            <div className="shader-banner ok">
              <span className="shader-badge">
                <Icon name="check" size={11} />
                已就绪
              </span>
              <div className="grow">
                <b>光影支持已装好</b>
                <span className="shader-sub">{shaderStatus.found.join(' · ')}</span>
              </div>
              <button className="btn sm ghost" disabled={shaderInstalling} onClick={() => void installShader()}>
                {shaderInstalling ? '安装中…' : '重新检查/安装'}
              </button>
            </div>
          ) : (
            <div className="shader-banner">
              <div className="grow">
                <b>还没装光影模组？</b>
                <span className="shader-sub">
                  {instance.loader.kind === 'forge'
                    ? 'Forge 用 OptiFine：一键安装会把 OptiFine 直接放进 mods 目录。官网有广告跳转页，可能要等一两分钟。'
                    : 'Fabric / NeoForge 用 Iris：一键安装会把 Iris、Sodium 和依赖一起下好。'}
                </span>
              </div>
              <button className="btn sm primary" disabled={shaderInstalling} onClick={() => void installShader()}>
                {shaderInstalling ? '安装中…' : '一键安装光影支持'}
              </button>
            </div>
          )}
          {shaderMsg ? (
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 12, whiteSpace: 'pre-line' }}>
              {shaderMsg}
            </div>
          ) : null}
          <div className="shader-hint">
            光影包（.zip）放进 shaderpacks 目录后，进游戏在「选项 → 视频设置 → 光影」里选择。
            {shaderStatus?.ready ? ' 这一项要进过一次游戏才会出现。' : ''}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12 }}>
          材质包（.zip）会改变方块与物品的外观，放进 resourcepacks 目录后进入游戏即可启用。
        </div>
      )}

      {packs === null ? (
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>读取中…</div>
      ) : packs.length === 0 ? (
        <Empty title={`${dirName} 目录是空的`} hint={`把 .zip 放进 ${dirName} 目录，或点下方按钮打开目录手动拖入`} />
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {packs.map((p) => (
            <div key={p.fileName} className="list-row">
              <Icon name="palette" size={15} style={{ color: 'var(--text-3)' }} />
              <div className="grow">
                <b style={{ fontSize: 11.5 }}>{p.fileName.replace(/\.(zip|jar)(\.disabled)?$/, '')}</b>
                <div className="m">
                  {(p.size / 1024 / 1024).toFixed(2)} MB {p.enabled ? '' : ' · 已停用'}
                </div>
              </div>
              <button className="btn sm ghost" disabled={busy === p.fileName} onClick={() => void toggle(p)}>
                {p.enabled ? '停用' : '启用'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

