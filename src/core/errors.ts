/**
 * 统一错误形态。渲染层只依赖 code，文案走 errors 表，避免把英文栈抛给玩家。
 */

export class NovaError extends Error {
  constructor(
    public code: string,
    message: string,
    public cause?: unknown,
    public retryable = false,
    public context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'NovaError'
  }
}

export function fail(code: string, message: string, context?: Record<string, unknown>): NovaError {
  return new NovaError(code, message, undefined, false, context)
}

export function wrap(code: string, cause: unknown, message: string, retryable = true): NovaError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new NovaError(code, `${message}${detail ? `（${detail}）` : ''}`, cause, retryable)
}

export function toResultError(e: unknown): { ok: false; code: string; message: string } {
  if (e instanceof NovaError) return { ok: false, code: e.code, message: e.message }
  if (e instanceof Error) return { ok: false, code: 'E_UNKNOWN', message: e.message }
  return { ok: false, code: 'E_UNKNOWN', message: String(e) }
}

/** 用户可读文案（主进程兜底用，UI 侧有同样的表） */
export const ERROR_TEXT: Record<string, string> = {
  E_MANIFEST_UNAVAILABLE: '无法获取 Minecraft 版本清单，请检查网络或切换镜像源',
  E_VERSION_NOT_FOUND: '版本不存在或已被移除',
  E_DOWNLOAD_FAILED: '文件下载失败',
  E_HASH_MISMATCH: '文件校验不通过，已重新下载',
  E_DISK_FULL: '磁盘空间不足',
  E_EXTRACT_FAILED: '依赖解压失败',
  E_JAVA_MISSING: '未找到可用的 Java 运行时',
  E_JAVA_DOWNLOAD: '下载 Java 运行时失败，请检查网络或切换下载源',
  E_JAVA_VERSION_MISMATCH: 'Java 主版本不满足该游戏版本要求',
  E_JAVA_ARCH_MISMATCH: 'Java 架构与系统不匹配',
  E_AUTH_EXPIRED: '登录已过期，请重新登录',
  E_INVALID_NAME: '用户名格式不正确',
  E_ACCOUNT_MISSING: '请先选择一个账号',
  E_MOD_CONFLICT: '存在模组依赖冲突',
  E_MODPACK_FORMAT: '整合包格式无法识别',
  E_MODPACK_LOADER: '这个整合包用的加载器暂不支持自动安装',
  E_IMPORT_CANCELLED: '导入已取消',
  E_IMPORT_RUNNING: '这个实例正在导入中',
  E_BACKGROUND_UNSUPPORTED: '这张图片读不出来，换一张 png / jpg / webp 试试',
  E_BACKGROUND_MISSING: '这个实例里还没有可用的世界截图，先进游戏存个档或截张图',
  E_OPEN_PATH: '打不开这个位置，可能被系统或安全软件拦了',
  E_FABRIC_UNREACHABLE: '连不上 Fabric 服务，请检查网络或到设置里切换下载源',
  E_MOD_DEPS_MISSING: '缺少前置模组，打开「模组」可以一键补齐',
  E_GAME_CRASH: '游戏异常退出',
  E_FRPC_MISSING: '内置 frpc 没有找到，请重新安装 NovaMC',
  E_FRPC_RUNNING: 'frpc 已在运行',
  E_TUNNEL_AUTH: '访问令牌无效或已过期',
  E_TUNNEL_CONFIG: '无法生成隧道配置，请检查凭据或重试',
  E_TUNNEL_RUNNING: '已有一条隧道在运行，请先停止再切换',
  E_UNKNOWN: '发生未知错误'
}

export function describe(code: string): string {
  return ERROR_TEXT[code] ?? ERROR_TEXT.E_UNKNOWN
}
