import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp, invoke } from '../store'
import { Icon } from '../icons'
import { Empty, fmtDate } from '../components'
import SkinAvatar from '../components/SkinAvatar'
import type { Account } from '@core/types'
import type { ReactElement } from 'react'

/**
 * 账号页。
 *
 * 头像是运行时渲染的 Minecraft 皮肤头部（等轴测 3D）：
 *   - 内置原版 Steve / Alex 皮肤（按 classic / slim 皮肤模型区分）
 *   - 用户上传的自定义皮肤（自动支持第二层帽子 overlay）
 */
export default function AccountsPage(): ReactElement {
  const accounts = useApp((s) => s.accounts)
  const config = useApp((s) => s.config)
  const reload = useApp((s) => s.reload)
  const notify = useApp((s) => s.notify)

  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [skinModel, setSkinModel] = useState<'classic' | 'slim'>('classic')
  /** 账号 id → 自定义皮肤 data URL */
  const [skins, setSkins] = useState<Record<string, string | null>>({})

  const activeId = useMemo(() => {
    if (!accounts.length) return null
    return accounts.find((a) => a.id === config?.activeAccountId)?.id ?? accounts[0].id
  }, [accounts, config?.activeAccountId])

  /** 加载所有账号的自定义皮肤 */
  const loadSkins = useCallback(async (list: Account[]): Promise<void> => {
    const entries = await Promise.all(
      list.map(async (a) => {
        const url = await invoke(() => window.nova.auth.skinDataUrl(a.id), '读取皮肤失败')
        return [a.id, url ?? null] as const
      })
    )
    setSkins(Object.fromEntries(entries))
  }, [])

  useEffect(() => {
    void loadSkins(accounts)
  }, [accounts, loadSkins])

  const add = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    const acc = await invoke(
      () => window.nova.auth.addOffline(name.trim(), skinModel),
      '创建账号失败'
    )
    setBusy(false)
    if (acc) {
      await invoke(() => window.nova.auth.activate(acc.id), '切换账号失败')
      setName('')
      await reload()
      notify('success', '离线账号已创建', `${acc.name} · ${skinModel === 'classic' ? '经典' : '纤细'}皮肤`)
    }
  }

  const activate = async (id: string): Promise<void> => {
    await invoke(() => window.nova.auth.activate(id), '切换账号失败')
    await reload()
  }

  const remove = async (id: string): Promise<void> => {
    await invoke(() => window.nova.auth.remove(id), '删除账号失败')
    await reload()
  }

  const setSkin = async (id: string): Promise<void> => {
    const acc = await invoke(() => window.nova.auth.setSkin(id), '设置皮肤失败')
    if (acc) {
      await reload()
      await loadSkins(accounts)
      notify('success', '皮肤已应用', '第二层帽子 overlay 会自动叠加显示')
    }
  }

  const clearSkin = async (id: string): Promise<void> => {
    const acc = await invoke(() => window.nova.auth.clearSkin(id), '清除皮肤失败')
    if (acc) {
      await reload()
      setSkins((prev) => ({ ...prev, [id]: null }))
      notify('info', '已恢复默认皮肤')
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>账号</h1>
          <div className="sub">
            {accounts.length} 个账号 · 头像是 Minecraft 原版皮肤渲染，支持双层帽子 overlay
          </div>
        </div>
      </div>

      <div className="section" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* ------------------------------------------------------ 左列：账号列表 */}
        <div className="grow col" style={{ gap: 12 }}>
          {accounts.length === 0 ? (
            <Empty title="还没有账号" hint="在右侧输入用户名创建离线账号" />
          ) : (
            accounts.map((acc) => {
              const isCurrent = activeId === acc.id
              const custom = skins[acc.id]
              return (
                <div key={acc.id} className={`acct-card ${isCurrent ? 'current' : ''}`}>
                  <SkinAvatar skinModel={acc.skinModel} skinUrl={custom} size={56} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                      <span className="acct-name">{acc.name}</span>
                      {isCurrent ? (
                        <span className="badge accent">
                          <i className="dot" />
                          当前账号
                        </span>
                      ) : null}
                      <span className="badge">{acc.skinModel === 'slim' ? '纤细' : '经典'}</span>
                      {custom ? <span className="badge accent">自定义皮肤</span> : null}
                    </div>
                    <div className="acct-meta">
                      {acc.type === 'offline' ? '离线账号' : 'Microsoft 正版'} · 创建于{' '}
                      {fmtDate(acc.createdAt)}
                    </div>
                    <div className="acct-uuid">{acc.id}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
                    <button className="btn sm ghost" onClick={() => void setSkin(acc.id)}>
                      <Icon name="palette" size={11} />
                      {custom ? '更换皮肤' : '自定义皮肤'}
                    </button>
                    {custom ? (
                      <button
                        className="btn sm ghost"
                        onClick={() => void clearSkin(acc.id)}
                        title="恢复默认皮肤"
                      >
                        恢复默认
                      </button>
                    ) : null}
                    {!isCurrent ? (
                      <button className="btn sm primary" onClick={() => void activate(acc.id)}>
                        切换
                      </button>
                    ) : null}
                    <button
                      className="btn sm danger"
                      onClick={() => void remove(acc.id)}
                      title="删除账号"
                    >
                      <Icon name="trash" size={11} />
                    </button>
                  </div>
                </div>
              )
            })
          )}

          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-2)', fontWeight: 500, marginBottom: 5 }}>
              离线账号是怎么算 UUID 的
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', lineHeight: 1.7 }}>
              与 Java 端 <span className="mono">UUID.nameUUIDFromBytes(("OfflinePlayer:" + name))</span>{' '}
              完全一致，所以同一用户名在离线服务器白名单里能对上；换名字等于换了个人。
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------ 右列：创建账号 */}
        <div
          className="card"
          style={{ width: 336, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>创建离线账号</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.7 }}>
              3-16 位字母、数字或下划线。离线账号不需要密码，也不需要联网验证。
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label style={{ fontSize: 10.5, color: 'var(--text-2)', fontWeight: 500 }}>用户名</label>
            <input
              className="input"
              placeholder="例如 Steve"
              value={name}
              maxLength={16}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
            />
          </div>

          {/* 皮肤模型选择：实时渲染原版皮肤的 3D 头做预览 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label style={{ fontSize: 10.5, color: 'var(--text-2)', fontWeight: 500 }}>皮肤模型</label>
            <div className="skin-pick">
              <button
                className={`skin-pick-item ${skinModel === 'classic' ? 'on' : ''}`}
                onClick={() => setSkinModel('classic')}
              >
                <SkinAvatar skinModel="classic" size={44} />
                <span>经典</span>
              </button>
              <button
                className={`skin-pick-item ${skinModel === 'slim' ? 'on' : ''}`}
                onClick={() => setSkinModel('slim')}
              >
                <SkinAvatar skinModel="slim" size={44} />
                <span>纤细</span>
              </button>
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--text-3)', lineHeight: 1.65 }}>
              {skinModel === 'classic'
                ? '经典模型对应 Steve 皮肤，手臂宽度 4px。'
                : '纤细模型对应 Alex 皮肤，手臂宽度 3px。'}
              创建后可在账号卡片上传自定义皮肤（64×64 PNG，含帽子 overlay 也能正确显示）。
            </div>
          </div>

          <button className="btn primary" onClick={() => void add()} disabled={busy || !name.trim()}>
            {busy ? '创建中…' : '创建离线账号'}
          </button>

          {/* 微软登录占位 */}
          <div
            style={{
              padding: '11px 13px',
              borderRadius: 10,
              background: 'var(--surface-2)',
              border: '1px solid var(--border)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600 }}>微软账号登录</span>
              <span className="badge">即将上线</span>
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
              登录正版账号后可使用自己的皮肤与正版服务器。当前版本已预留{' '}
              <span className="mono">type: 'microsoft'</span> 与令牌字段。
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
