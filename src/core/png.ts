/**
 * 轻量 PNG 校验：只读文件头判断格式与尺寸，不解码整张图。
 * 用于校验用户上传的皮肤是不是 64×64 的标准展开图。
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)
}

/** 读 PNG 头里的宽高；不是合法 PNG 返回 null */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (!isPng(buf) || buf.length < 24) return null
  // IHDR 块：8 字节签名 + 4 长度 + 4 类型 + 宽(4) + 高(4)
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
