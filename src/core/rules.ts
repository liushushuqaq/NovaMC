import type { ArgEntry, Rule } from './types'

export interface OsContext {
  name: 'windows' | 'osx' | 'linux'
  arch: string
  version: string
  features: Record<string, boolean>
}

/**
 * 规则求值：allow 列表里任一命中即允许，deny 命中即拒绝。
 * 没有 rules 的库视为对所有平台生效。
 */
export function rulesAllow(rules: Rule[] | undefined, ctx: OsContext): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (!matchOs(rule, ctx)) continue
    if (!matchFeatures(rule, ctx)) continue
    if (rule.action === 'deny') return false
    allowed = true
  }
  return allowed
}

function matchOs(rule: Rule, ctx: OsContext): boolean {
  if (!rule.os) return true
  if (rule.os.name && rule.os.name !== ctx.name) return false
  if (rule.os.arch) {
    const want = rule.os.arch
    const normalized = ctx.arch === 'x64' ? 'x86_64' : ctx.arch === 'arm64' ? 'arm64' : 'x86'
    if (want !== ctx.arch && want !== normalized) return false
  }
  if (rule.os.version) {
    try {
      if (!new RegExp(rule.os.version).test(ctx.version)) return false
    } catch {
      return false
    }
  }
  return true
}

function matchFeatures(rule: Rule, ctx: OsContext): boolean {
  if (!rule.features) return true
  return Object.entries(rule.features).every(([k, v]) => Boolean(ctx.features[k]) === v)
}

/** 展开 arguments.game / arguments.jvm，做 ${} 替换 */
export function expandArgs(entries: ArgEntry[], ctx: OsContext, vars: Record<string, string>): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push(substitute(entry, vars))
      continue
    }
    if (!rulesAllow(entry.rules, ctx)) continue
    const values = Array.isArray(entry.value) ? entry.value : [entry.value]
    for (const v of values) out.push(substitute(v, vars))
  }
  return out
}

export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([^}]+)\}/g, (whole, key: string) => vars[key] ?? whole)
}

/** 1.13 以前的 minecraftArguments 是空格分隔的单串 */
export function legacySplit(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean)
}
