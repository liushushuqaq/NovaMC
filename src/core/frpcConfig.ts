/**
 * frpc 配置格式转换。
 *
 * 樱花的 `POST /tunnel/config` 会根据请求里的 `frpc` 版本参数返回
 * ini 或 toml 两种格式（官方 spec 里 `text/plain` 与 `text/toml` 并列）。
 * 而内置的官方 frpc v0.71 只认 TOML（`-c` 参数），
 * 所以拿到 ini 时需要转一道，避免因为格式不匹配导致启动失败。
 */

/**
 * 判断一段配置是不是 INI 格式。
 *
 * 区分依据：
 *   - INI 的 section 内字段通常**不缩进**，且值多为裸字符串
 *   - TOML 的 `[[proxy]]` 表格内字段是**缩进**的
 *   - INI 也可能用 `key: value` 冒号写法
 */
export function looksLikeIni(config: string): boolean {
  const lines = config.split(/\r?\n/)
  let indented = 0
  let plain = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith(';')) continue
    if (/^\[.+\]$/.test(t)) continue
    if (/^\s+\S+\s*[:=]/.test(line)) indented++
    else if (/^\S+\s*[:=]\s*\S/.test(line)) plain++
  }
  // 有冒号写法的字段 → INI
  if (/:/.test(config)) return true
  // 全部字段都不缩进且没有 TOML 的双括号表格 → INI
  if (indented === 0 && plain > 0 && !/\[\[/.test(config)) return true
  return false
}

/**
 * 把 INI 格式的 frpc 配置转成 TOML。
 *
 * frpc 的 INI 与 TOML 结构几乎一一对应：
 *   [common]              → [common]
 *   server_addr = 1.2.3.4 → serverAddr = "1.2.3.4"
 *   server_port = 7000    → serverPort = 7000
 *   [proxy]               → [[proxy]]
 *   type = tcp            → type = "tcp"
 *   [proxy.foo]           → [[proxy]] + name = "foo"
 */
export function iniToToml(ini: string): string {
  const out: string[] = []
  let currentSection = ''
  let isProxyArray = false

  const toValue = (raw: string): string => {
    const v = raw.trim()
    if (v === '') return '""'
    // 已经带引号
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v
    // 布尔
    if (v === 'true' || v === 'false') return v
    // 数字
    if (/^-?\d+$/.test(v)) return v
    if (/^-?\d*\.\d+$/.test(v)) return v
    // 其余当字符串
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  /** frpc 的 ini 键名 → TOML 键名 */
  const KEY_MAP: Record<string, string> = {
    server_addr: 'serverAddr',
    server_port: 'serverPort',
    auth_method: 'auth.method',
    auth_token: 'auth.token',
    tls_enable: 'transport.tls.enable',
    disable_log_color: 'log.to',
    log_file: 'log.file',
    log_level: 'log.level',
    local_ip: 'localIP',
    local_port: 'localPort',
    remote_port: 'remotePort',
    custom_remote_address: 'customRemoteAddress',
    role: 'role',
    use_encryption: 'transport.useEncryption',
    use_compression: 'transport.useCompression',
    bandwidth_limit: 'transport.bandwidthLimit',
    name: 'name'
  }

  const mapKey = (k: string): string => {
    const key = k.trim().toLowerCase()
    if (KEY_MAP[key]) return KEY_MAP[key]
    // 已经是驼峰或点号形式就原样保留
    if (/[A-Z]/.test(k) || k.includes('.')) return k.trim()
    // 其余下划线转驼峰
    return k.trim().replace(/_([a-z])/g, (_, c) => c.toUpperCase())
  }

  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith(';')) continue

    const secMatch = t.match(/^\[(.+)\]$/)
    if (secMatch) {
      const sec = secMatch[1].trim()
      currentSection = sec
      const lower = sec.toLowerCase()
      if (lower === 'common') {
        out.push('[common]')
        isProxyArray = false
      } else if (lower === 'proxy') {
        out.push('[[proxy]]')
        isProxyArray = true
      } else if (lower.startsWith('proxy')) {
        // frpc 的 INI 约定：
        //   [proxy]   → 第一个代理（不写 name）
        //   [proxy2]  → 第二个代理（数字是索引，不是名字）
        //   [proxy.foo] → 具名代理
        const suffix = sec.slice('proxy'.length).trim()
        out.push('[[proxy]]')
        if (suffix && !/^\d+$/.test(suffix)) {
          // 具名代理才写 name；纯数字后缀交给 frpc 自己编号
          out.push(`name = ${JSON.stringify(suffix)}`)
        }
        isProxyArray = true
      } else if (lower.startsWith('plugin')) {
        out.push('[[plugins]]')
        isProxyArray = false
      } else if (lower.startsWith('visitor')) {
        out.push('[[visitors]]')
        isProxyArray = false
      } else {
        out.push(`[${sec}]`)
        isProxyArray = false
      }
      continue
    }

    const kv = t.match(/^([^=:]+)[=:](.*)$/)
    if (kv) {
      const key = mapKey(kv[1])
      const val = toValue(kv[2])
      out.push(`${key} = ${val}`)
      continue
    }
  }

  return out.join('\n') + '\n'
}

/**
 * 把服务端返回的配置统一成本地 frpc 能吃的 TOML。
 * 已经是 TOML 就原样返回。
 */
export function toFrpcToml(config: string): string {
  const trimmed = config.trim()
  if (!trimmed) return trimmed
  // TOML 的表格内字段是缩进的；INI 通常不缩进
  if (looksLikeIni(trimmed)) return iniToToml(trimmed)
  return trimmed
}
