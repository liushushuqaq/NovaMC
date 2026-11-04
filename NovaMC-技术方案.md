# NovaMC Launcher — 技术方案与核心实现

> 配套设计稿：Ardot `https://ardot.tencent.com/file/743492153539132`
> 六个界面：主页 / 版本库 / 实例 / 实例详情·模组依赖 / 账号（浅色主题）/ 设置

---

## 1. 技术选型

| 维度 | 选择 | 理由 |
|---|---|---|
| 壳层 | **Electron 33 + electron-vite** | 启动器需要长驻 Node 能力（FS、子进程、系统钥匙串），Electron 直接复用 Node 生态；Tauri 包体更小（~10 MB vs ~110 MB），但 Forge/NeoForge 安装要调 Java 子进程 + 解压 + 大量 IO，用 Rust 重写这些胶水代码收益低于成本。若包体是硬指标，可换 Tauri 2，`packages/core` 的算法层几乎可平移 |
| UI | **React 18 + TypeScript + Zustand + Tailwind** | 页面状态机简单（6 个主页面 + 若干抽屉），不需要重型路由/状态库 |
| 进程模型 | 主进程持有全部副作用，渲染进程纯展示 | 通过 `contextBridge` 暴露白名单 IPC，`nodeIntegration: false`、`contextIsolation: true` |
| 存储 | 实例 `instance.json` + 全局 `config.json`；账号令牌走 **OS 钥匙串**（`keytar` / `safeStorage`） | 配置可读可改，凭据不落盘明文 |
| 打包 | electron-builder（nsis / dmg / AppImage + deb） | 三平台一套配置 |

**关键约束**：`packages/core` 是纯 TypeScript、零 Electron 依赖，可在 Node 里直接跑单测，也方便将来换壳。

---

## 2. 工程结构

```
novamc/
├─ electron.vite.config.ts
├─ package.json
├─ src/
│  ├─ main/                        # 主进程：唯一有副作用的地方
│  │  ├─ index.ts                  # 窗口 / 单实例锁 / 生命周期
│  │  ├─ ipc/
│  │  │  ├─ version.ipc.ts         # 版本清单、安装进度
│  │  │  ├─ instance.ipc.ts        # 实例 CRUD
│  │  │  ├─ launch.ipc.ts          # 启动 / 停止 / 日志流
│  │  │  ├─ auth.ipc.ts            # 登录 / 切换 / 刷新
│  │  │  └─ modpack.ipc.ts         # 搜索 / 安装 / 依赖解析
│  │  ├─ services/                 # core 的薄包装：注入路径、日志、进度通道
│  │  └─ store/
│  │     ├─ ConfigStore.ts
│  │     └─ InstanceStore.ts
│  ├─ preload/index.ts             # contextBridge 白名单
│  └─ renderer/
│     ├─ app/App.tsx               # Sidebar + 内容区
│     ├─ pages/
│     │  ├─ HomePage.tsx           # 设计稿 01
│     │  ├─ VersionsPage.tsx       # 设计稿 02
│     │  ├─ InstancesPage.tsx      # 设计稿 03
│     │  ├─ InstanceDetailPage.tsx # 设计稿 04（模组 / 依赖冲突）
│     │  ├─ AccountsPage.tsx       # 设计稿 05
│     │  └─ SettingsPage.tsx       # 设计稿 06
│     ├─ components/  (Sidebar, InstanceCard, VersionTable, ProgressToast…)
│     └─ styles/tokens.css         # 与设计稿同一套 token，含 dark / light
└─ packages/core/                  # 纯逻辑，可单测
   ├─ version/    manifest.ts  resolve.ts  rules.ts
   ├─ install/    installer.ts download.ts assets.ts natives.ts verify.ts
   ├─ launch/     builder.ts  process.ts
   ├─ java/       detect.ts  provision.ts
   ├─ auth/       microsoft.ts  offline.ts  chain.ts
   ├─ modpack/    modrinth.ts  curseforge.ts  resolver.ts  mrpack.ts
   ├─ fs/         paths.ts  zip.ts  atomic.ts
   └─ errors.ts
```

**运行目录（按平台）**

```
Windows  %APPDATA%\NovaMC
macOS    ~/Library/Application Support/NovaMC
Linux    ~/.local/share/NovaMC

NovaMC/
├─ config.json                 # 全局设置（Java、内存、主题、镜像）
├─ accounts.json               # 仅存 uuid / name / type，令牌在钥匙串
├─ meta/                       # version_manifest_v2.json + ETag
├─ versions/<id>/              # version.json、client.jar、<id>.json(合并后)
├─ libraries/<group>/<artifact>/<ver>/...
├─ assets/
│  ├─ indexes/<assetIndexId>.json
│  ├─ objects/<ab>/<sha1>
│  └─ virtual/legacy/...
├─ runtime/java-21-temurin/    # 受管 JRE
└─ instances/<slug>/
   ├─ instance.json
   ├─ .minecraft/              # 独立 gameDir：mods / configs / saves / resourcepacks
   └─ natives/
```

---

## 3. 分层

```
┌──────────────────────── renderer (React) ────────────────────────┐
│ 页面 ← Zustand store ← window.nova.* (preload 白名单)             │
└───────────────────────────────┬──────────────────────────────────┘
                                │ ipcRenderer.invoke / on
┌───────────────────────────────▼──────────────────────────────────┐
│ main：路径注入、日志、进度节流、崩溃兜底                            │
├──────────────────────────────────────────────────────────────────┤
│ core：ManifestService / Installer / LaunchBuilder /               │
│       JavaDetector / AuthChain / ModpackResolver                  │
├──────────────────────────────────────────────────────────────────┤
│ 基础设施：HttpClient(重试/镜像)  DownloadPool  ZipUtil  Hash  Logger │
└──────────────────────────────────────────────────────────────────┘
```

设计稿中每个界面都是这几个服务的"投影"：

| 界面 | 主要数据源 |
|---|---|
| 主页 | `InstanceStore.default` + `ManifestService.latest` + `DownloadPool.progress` |
| 版本库 | `ManifestService.list()` 与 `InstallRegistry`（已安装集合） |
| 实例 | `InstanceStore.all()` |
| 实例详情 | `ModpackResolver` 结果 + 本地 `mods/` 扫描 |
| 账号 | `AuthChain.accounts` + 令牌有效期 |
| 设置 | `ConfigStore` + `JavaDetector.runtimes` |

---

## 4. 数据模型

```ts
// packages/core/version/manifest.ts
export type VersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha';

export interface VersionSummary {
  id: string;            // "1.21.4" / "25w45a"
  type: VersionType;
  url: string;           // 该版本完整 JSON
  sha1: string;
  releaseTime: string;   // ISO8601，用于列表排序与"发布日期"列
  complianceLevel?: number;
}

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: VersionSummary[];
}
```

```ts
// packages/core/version/resolve.ts —— version.json 的关键切片
export interface VersionJson {
  id: string;
  type: VersionType;
  mainClass: string;
  assets: string;                       // assetIndex 的 id
  assetIndex: { id: string; sha1: string; size: number; totalSize: number; url: string };
  downloads: {
    client: Artifact;
    client_mappings?: Artifact;
  };
  libraries: Library[];
  javaVersion?: { component: string; majorVersion: number };
  arguments?: { game: ArgEntry[]; jvm: ArgEntry[] };
  minecraftArguments?: string;          // 1.13 以前
  minimumLauncherVersion: number;
}

export interface Artifact { path?: string; sha1: string; size: number; url: string }

export interface Library {
  name: string;                          // group:artifact:version[:classifier]
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> };
  natives?: Record<string, string>;      // { windows: "natives-windows" }
  rules?: Rule[];
  extract?: { exclude: string[] };
}

export type ArgEntry = string | { rules?: Rule[]; value: string | string[] };

export interface Rule {
  action: 'allow' | 'deny';
  os?: { name?: 'windows' | 'osx' | 'linux'; arch?: string; version?: string };
  features?: Record<string, boolean>;
}
```

```ts
// packages/core/types/instance.ts
export type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt';

export interface InstanceConfig {
  id: string;              // uuid
  name: string;            // "All the Mods 10"
  slug: string;            // 目录名，唯一
  createdAt: string;
  lastPlayedAt?: string;

  // 版本锚点
  gameVersion: string;     // "1.21.4"
  loader: { kind: LoaderKind; version?: string };

  // 每个实例独立配置
  java: { mode: 'auto' | 'managed' | 'custom'; path?: string; majorVersion?: number };
  memory: { minMb: number; maxMb: number };
  window: { width: number; height: number; fullscreen: boolean };
  jvmArgs: string[];       // 额外 JVM 参数
  gameArgs: string[];      // 额外游戏参数
  env?: Record<string, string>;

  // 来源（整合包安装的实例）
  source?: { provider: 'modrinth' | 'curseforge'; projectId: string; versionId: string };
  mods: ModEntry[];
  verifyOnLaunch: boolean;
}

export interface ModEntry {
  fileName: string;
  projectId?: string;
  versionId?: string;
  provider?: 'modrinth' | 'curseforge' | 'local';
  sha1?: string;
  enabled: boolean;
  dependencies?: { projectId: string; versionId?: string; type: 'required' | 'optional' | 'incompatible' }[];
}
```

```ts
// packages/core/types/account.ts
export interface Account {
  id: string;                 // MC profile uuid（离线为离线 UUID）
  name: string;
  type: 'microsoft' | 'offline';
  skinModel?: 'classic' | 'slim';
  // 令牌不入 accounts.json
  tokens?: { accessToken: string; refreshToken?: string; expiresAt: number; xuid?: string };
}
```

---

## 5. 版本清单：拉取、缓存、条件请求

```ts
// packages/core/version/manifest.ts
import { HttpClient } from '../fs/http';
import { errors } from '../errors';
import fs from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const TTL = 6 * 3600_000;

export class ManifestService {
  constructor(private http: HttpClient, private metaDir: string) {}

  private get cacheFile() { return path.join(this.metaDir, 'version_manifest_v2.json'); }
  private get etagFile()  { return path.join(this.metaDir, 'version_manifest_v2.etag'); }

  /** force=true 时忽略 TTL，仍使用 ETag 做条件请求 */
  async load(force = false): Promise<VersionManifest> {
    const cached = await this.readCache();
    if (!force && cached && Date.now() - cached.mtime < TTL) return cached.data;

    const etag = cached ? await this.readEtag() : undefined;
    try {
      const res = await this.http.getJson<VersionManifest>(MANIFEST_URL, {
        headers: etag ? { 'If-None-Match': etag } : {},
        timeoutMs: 15_000,
      });
      if (res.status === 304 && cached) return cached.data;
      await fs.mkdir(this.metaDir, { recursive: true });
      await fs.writeFile(this.cacheFile, JSON.stringify(res.body));
      if (res.headers.etag) await fs.writeFile(this.etagFile, res.headers.etag);
      return res.body;
    } catch (e) {
      // 关键策略：离线优先用旧缓存，只有从未成功过才抛错
      if (cached) return cached.data;
      throw errors.wrap('E_MANIFEST_UNAVAILABLE', e, '无法获取 Minecraft 版本清单');
    }
  }

  /** 版本列表筛选：按设计稿 02 的 全部 / 正式版 / 快照 / 旧版 */
  static filter(list: VersionSummary[], tab: 'all' | 'release' | 'snapshot' | 'legacy') {
    if (tab === 'all') return list;
    if (tab === 'release') return list.filter(v => v.type === 'release');
    if (tab === 'snapshot') return list.filter(v => v.type === 'snapshot');
    return list.filter(v => v.type === 'old_beta' || v.type === 'old_alpha');
  }

  private async readCache() {
    try {
      const [raw, st] = await Promise.all([fs.readFile(this.cacheFile, 'utf8'), fs.stat(this.cacheFile)]);
      return { data: JSON.parse(raw) as VersionManifest, mtime: st.mtimeMs };
    } catch { return null; }
  }
  private async readEtag() { try { return (await fs.readFile(this.etagFile, 'utf8')).trim(); } catch { return undefined; } }
}
```

---

## 6. 下载器：并发、镜像回落、哈希校验、断点重试

```ts
// packages/core/install/download.ts
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export interface DownloadTask {
  url: string;
  mirrors?: string[];        // BMCLAPI 等，按顺序回落
  dest: string;
  sha1?: string;
  size?: number;
  label: string;             // 用于进度面板展示
}

export interface ProgressEvent {
  phase: 'download' | 'extract' | 'verify';
  totalFiles: number;
  doneFiles: number;
  totalBytes: number;
  doneBytes: number;
  current: string;
  speedBps: number;
}

export class DownloadPool {
  constructor(
    private http: HttpClient,
    private opts = { concurrency: 8, retries: 3, timeoutMs: 30_000 },
  ) {}

  /** 按设计稿侧边栏"下载队列"需要的粒度回调进度（默认 120ms 节流） */
  async run(tasks: DownloadTask[], onProgress: (e: ProgressEvent) => void): Promise<DownloadReport> {
    const totalBytes = tasks.reduce((s, t) => s + (t.size ?? 0), 0);
    let doneFiles = 0, doneBytes = 0, skipped = 0;
    const failed: { task: DownloadTask; error: Error }[] = [];
    let lastEmit = 0;

    const emit = (current: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 120) return;
      lastEmit = now;
      onProgress({ phase: 'download', totalFiles: tasks.length, doneFiles, totalBytes, doneBytes, current, speedBps: 0 });
    };

    const worker = async (t: DownloadTask) => {
      // 1) 已存在且哈希正确 → 直接跳过（版本库切换时命中率很高）
      if (t.sha1 && await this.verify(t.dest, t.sha1)) { doneFiles++; doneBytes += t.size ?? 0; skipped++; emit(t.label); return; }

      // 2) 主源 + 镜像，逐次重试，指数退避
      const urls = [t.url, ...(t.mirrors ?? [])];
      let lastErr: unknown;
      for (let attempt = 0; attempt < this.opts.retries; attempt++) {
        const url = urls[attempt % urls.length];
        try {
          await fs.mkdir(path.dirname(t.dest), { recursive: true });
          const tmp = `${t.dest}.part`;
          const body = await this.http.stream(url, { timeoutMs: this.opts.timeoutMs });
          await pipeline(body, createWriteStream(tmp));

          // 3) 校验不通过就当下载失败，删掉脏文件重来
          if (t.sha1 && !(await this.verify(tmp, t.sha1))) {
            await fs.rm(tmp, { force: true });
            throw new Error(`SHA-1 mismatch: ${path.basename(t.dest)}`);
          }
          await fs.rename(tmp, t.dest);
          doneFiles++; doneBytes += t.size ?? 0; emit(t.label);
          return;
        } catch (e) {
          lastErr = e;
          await sleep(400 * 2 ** attempt + Math.random() * 200);
        }
      }
      failed.push({ task: t, error: errors.wrap('E_DOWNLOAD_FAILED', lastErr, t.label) });
    };

    // 4) 固定并发池
    const queue = [...tasks];
    await Promise.all(Array.from({ length: this.opts.concurrency }, async () => {
      while (queue.length) await worker(queue.shift()!);
    }));
    emit('', true);

    if (failed.length) {
      // 全部失败才算失败；部分失败交给上层决定"跳过损坏资源继续启动"
      throw new AggregateDownloadError(failed);
    }
    return { total: tasks.length, skipped, bytes: doneBytes };
  }

  private async verify(file: string, sha1: string): Promise<boolean> {
    try {
      const hash = crypto.createHash('sha1');
      const fd = await fs.open(file, 'r');
      try {
        for await (const chunk of fd.createReadStream()) hash.update(chunk);
      } finally { await fd.close(); }
      return hash.digest('hex') === sha1;
    } catch { return false; }
  }
}
```

**镜像策略**：`config.mirror = 'auto' | 'official' | 'bmclapi'`。`auto` 时主源超时 > 8s 或连续 3 个文件失败，整体切到镜像并记住选择（会话级），下个会话重新探测。

---

## 7. 安装流水线

```ts
// packages/core/install/installer.ts
export type InstallStage =
  | 'resolve' | 'client' | 'libraries' | 'natives' | 'assets' | 'loader' | 'mods' | 'done';

export class Installer {
  constructor(
    private http: HttpClient,
    private pool: DownloadPool,
    private paths: GamePaths,
  ) {}

  async install(spec: InstallSpec, onStage: (s: InstallStage, p?: ProgressEvent) => void): Promise<ResolvedVersion> {
    onStage('resolve');

    // 1) 解析版本 JSON（含 inheritFrom 链：Fabric/Forge 的 profile 会继承原版）
    const raw = await this.fetchVersionJson(spec.gameVersion);
    const merged = await this.resolveInheritance(raw, spec.loader);

    // 2) 客户端 jar
    onStage('client');
    const clientJar = this.paths.versionJar(merged.id);
    await this.pool.run([{
      url: merged.downloads.client.url,
      mirrors: [mirror(merged.downloads.client.url)],
      dest: clientJar,
      sha1: merged.downloads.client.sha1,
      size: merged.downloads.client.size,
      label: `client-${merged.id}.jar`,
    }], p => onStage('client', p));

    // 3) 依赖库：只保留当前平台规则通过、且有 artifact 的条目
    onStage('libraries');
    const libs = mergeLibraries(merged.libraries)
      .filter(l => rulesAllow(l.rules, this.platform.features(), this.platform.os()))
      .filter(l => l.downloads?.artifact);
    await this.pool.run(libs.map(l => ({
      url: l.downloads!.artifact!.url,
      mirrors: [mirror(l.downloads!.artifact!.url)],
      dest: this.paths.library(l.downloads!.artifact!.path ?? mavenToPath(l.name)),
      sha1: l.downloads!.artifact!.sha1,
      size: l.downloads!.artifact!.size,
      label: l.name,
    })), p => onStage('libraries', p));

    // 4) natives：解压带 classifier 的 jar，遵守 extract.exclude
    onStage('natives');
    await extractNatives(merged.libraries, this.platform.os(), this.paths.nativesDir(merged.id));

    // 5) 资源索引：~3000 个文件，必须先下索引再批量下对象
    onStage('assets');
    await this.installAssets(merged.assetIndex, p => onStage('assets', p));

    onStage('done');
    return { id: merged.id, javaMajor: merged.javaVersion?.majorVersion ?? 8, json: merged };
  }

  /** 资源对象按 hash 寻址：assets/objects/<前两位>/<hash> */
  private async installAssets(index: AssetIndexRef, cb: (p: ProgressEvent) => void) {
    const local = this.paths.assetIndex(index.id);
    await this.pool.run([{ url: index.url, dest: local, sha1: index.sha1, size: index.size, label: `assets-${index.id}` }], () => {});

    const { objects, virtual, map_to_resources } = JSON.parse(await fs.readFile(local, 'utf8'));
    const tasks: DownloadTask[] = [];
    for (const [name, o] of Object.entries<{ hash: string; size: number }>(objects)) {
      const dest = this.paths.assetObject(o.hash);
      if (await exists(dest)) continue;              // 多实例共享，命中即跳过
      tasks.push({
        url: `https://resources.download.minecraft.net/${o.hash.slice(0, 2)}/${o.hash}`,
        mirrors: [`https://bmclapi2.bangbang93.com/assets/${o.hash.slice(0, 2)}/${o.hash}`],
        dest, sha1: o.hash, size: o.size, label: name,
      });
    }
    await this.pool.run(tasks, cb);

    // 1.6 及更早版本需要 legacy 虚拟目录
    if (virtual || map_to_resources) {
      for (const [name, o] of Object.entries<{ hash: string }>(objects)) {
        const target = path.join(this.paths.assetsVirtual(), name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(this.paths.assetObject(o.hash), target).catch(() => {});
      }
    }
  }
}
```

**合并规则（`inheritFrom`）**：`id / mainClass / assets / assetIndex / downloads.client` 以子版本为准；`libraries` 按 `group:artifact` 去重后合并（子版本覆盖同名）；`arguments` 拼接（jvm 子在前）；`javaVersion` 取子版本。

**启动前校验**（`verifyOnLaunch: true` 时，对应设计稿"完整性校验通过 · 2 分钟前"）：

```ts
async function quickVerify(instance: InstanceConfig, rv: ResolvedVersion) {
  const targets: DownloadTask[] = [
    { url: '', dest: paths.versionJar(rv.id), sha1: rv.json.downloads.client.sha1, label: 'client.jar' },
    ...collectLibraryArtifacts(rv.json),
  ];
  const dirty = [];
  for (const t of targets) if (!(await pool.verify(t.dest, t.sha1!))) dirty.push(t);
  return dirty;   // 只重下损坏项，不全量重装
}
```

---

## 8. Java 运行时探测与补全

```ts
// packages/core/java/detect.ts
export interface JavaRuntime {
  path: string;
  version: string;       // "21.0.5"
  major: number;         // 21
  vendor?: string;
  arch: 'x64' | 'arm64' | 'x86';
  managed: boolean;
}

const MIN_MAJOR_BY_GAME = (gameVersion: string, declared?: number): number => {
  if (declared) return declared;                       // 优先 version.json 的 javaVersion.majorVersion
  const [maj, min] = gameVersion.split('.').map(Number);
  if (maj === 1 && min >= 20) return 21;
  if (maj === 1 && min >= 18) return 17;
  if (maj === 1 && min >= 17) return 16;
  return 8;
};

export async function detectJava(customPaths: string[] = []): Promise<JavaRuntime[]> {
  const candidates = new Set<string>();

  if (process.platform === 'win32') {
    // 1) 注册表：JDK / JRE 的 JavaHome
    for (const root of ['HKLM\\SOFTWARE\\JavaSoft\\JDK', 'HKLM\\SOFTWARE\\JavaSoft\\JRE',
                        'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK']) {
      for (const v of await regSubKeys(root)) {
        const home = await regGet(`${root}\\${v}`, 'JavaHome');
        if (home) candidates.add(path.join(home, 'bin', 'java.exe'));
      }
    }
    // 2) 常见安装目录 + PATH
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      for (const dir of await safeReaddir(path.join(base, 'Java'))) candidates.add(path.join(base, 'Java', dir, 'bin', 'java.exe'));
      for (const dir of await safeReaddir(path.join(base, 'Eclipse Adoptium'))) candidates.add(path.join(base, 'Eclipse Adoptium', dir, 'bin', 'java.exe'));
    }
    for (const p of (process.env.PATH ?? '').split(';')) candidates.add(path.join(p, 'java.exe'));
  } else if (process.platform === 'darwin') {
    // /usr/libexec/java_home -V 会列出全部已安装 JDK
    const out = await exec('/usr/libexec/java_home', ['-V']);
    for (const m of out.matchAll(/(\d+\.\d+[^\s]*)\s*.*?:\s*"([^"]+)"/g)) {
      candidates.add(path.join(m[2], 'bin', 'java'));
    }
    candidates.add('/opt/homebrew/opt/openjdk/bin/java');
  } else {
    // Linux：发行版目录 + update-alternatives + PATH
    const out = await exec('update-alternatives', ['--list', 'java']).catch(() => '');
    out.split('\n').filter(Boolean).forEach(p => candidates.add(p.trim()));
    for (const base of ['/usr/lib/jvm', '/usr/java', path.join(os.homedir(), '.sdkman/candidates/java')]) {
      for (const dir of await safeReaddir(base)) candidates.add(path.join(base, dir, 'bin', 'java'));
    }
  }
  customPaths.forEach(p => candidates.add(p));

  const found: JavaRuntime[] = [];
  for (const p of candidates) {
    const info = await probeJava(p);
    if (info && !found.some(f => f.path === info.path)) found.push(info);
  }
  return found.sort((a, b) => b.major - a.major);
}

/** java -XshowSettings:properties -version 输出里取 java.version / java.vendor / os.arch */
async function probeJava(bin: string): Promise<JavaRuntime | null> {
  if (!(await exists(bin))) return null;
  try {
    const out = await exec(bin, ['-XshowSettings:properties', '-version'], { timeout: 4000 });
    const ver = /java\.version = (\S+)/.exec(out)?.[1];
    if (!ver) return null;
    const major = ver.startsWith('1.') ? Number(ver.split('.')[1]) : Number(ver.split('.')[0]);
    return { path: bin, version: ver, major, vendor: /java\.vendor = (.+)/.exec(out)?.[1]?.trim(),
             arch: /os\.arch = (\S+)/.exec(out)?.[1]?.includes('aarch64') ? 'arm64' : 'x64', managed: false };
  } catch { return null; }
}

/** 没有任何满足 major 的运行时 → 走受管 JRE（Adoptium API），返回可提示的下载任务 */
export async function provisionJava(major: number, os: string, arch: string) {
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
  return { url, dest: paths.runtimeDir(`java-${major}-temurin`) };
}
```

**失败兜底**（设计稿中的错误态）：
- 未安装且拒绝下载 → `E_JAVA_MISSING`，弹层给出"使用受管运行时 / 手动选择 java 可执行文件"两条路；
- 选中的 Java 主版本低于版本要求 → `E_JAVA_VERSION_MISMATCH`，提示"该版本需要 Java 21，当前为 17"；
- 32 位 Java 启动 64 位 natives → `E_JAVA_ARCH_MISMATCH`。

---

## 9. 启动参数组装

```ts
// packages/core/launch/builder.ts
export interface LaunchContext {
  version: ResolvedVersion;      // 合并后的 version.json
  instance: InstanceConfig;
  account: Account;
  java: JavaRuntime;
  paths: GamePaths;
  launcher: { name: string; version: string };
}

export function buildLaunchCommand(ctx: LaunchContext) {
  const { version, instance, account, java, paths, launcher } = ctx;
  const os = paths.osInfo();
  const features = {
    is_demo_user: false,
    has_custom_resolution: !instance.window.fullscreen,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const nativesDir = paths.nativesDir(instance.slug);
  const classpath = buildClasspath(version, paths);

  const vars: Record<string, string> = {
    auth_player_name: account.name,
    version_name: version.id,
    game_directory: paths.instanceGameDir(instance.slug),
    assets_root: paths.assetsRoot(),
    assets_index_name: version.assets ?? version.assetIndex.id,
    auth_uuid: account.id.replace(/-/g, ''),
    auth_access_token: account.tokens?.accessToken ?? '0',
    auth_session: account.tokens?.accessToken ?? '0',       // 老版本占位
    user_type: account.type === 'microsoft' ? 'msa' : 'legacy',
    version_type: version.type,
    user_properties: '{}',
    natives_directory: nativesDir,
    launcher_name: launcher.name,
    launcher_version: launcher.version,
    classpath,
    classpath_separator: path.delimiter,
    library_directory: paths.librariesRoot(),
    resolution_width: String(instance.window.width),
    resolution_height: String(instance.window.height),
  };

  // JVM 参数
  let jvmArgs: string[];
  if (version.arguments?.jvm) {
    jvmArgs = expandArgs(version.arguments.jvm, features, os, vars);
  } else {
    // 1.13 以前没有 arguments，用官方默认模板
    jvmArgs = [
      `-Djava.library.path=${nativesDir}`,
      '-cp', classpath,
      `-Dminecraft.launcher.brand=${launcher.name}`,
      `-Dminecraft.launcher.version=${launcher.version}`,
    ];
  }

  // 内存与实例覆盖（放在版本自带参数之后，用户意图优先）
  jvmArgs.unshift(
    `-Xms${instance.memory.minMb}M`,
    `-Xmx${instance.memory.maxMb}M`,
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=50',
    '-XX:G1HeapRegionSize=32M',
    `-Djava.library.path=${nativesDir}`,
    `-Dorg.lwjgl.system.SharedLibraryExtractPath=${nativesDir}`,
    `-Dio.netty.native.workdir=${nativesDir}`,
    `-Dminecraft.launcher.brand=${launcher.name}`,
    `-Dminecraft.launcher.version=${launcher.version}`,
  );
  if (instance.env) for (const [k, v] of Object.entries(instance.env)) jvmArgs.push(`-D${k}=${v}`);
  jvmArgs.push(...instance.jvmArgs);

  // 游戏参数
  const gameArgs = version.arguments?.game
    ? expandArgs(version.arguments.game, features, os, vars)
    : legacyExpand(version.minecraftArguments ?? '', vars);

  if (!instance.window.fullscreen) {
    gameArgs.push('--width', String(instance.window.width), '--height', String(instance.window.height));
  } else {
    gameArgs.push('--fullscreen');
  }
  gameArgs.push(...instance.gameArgs);

  // 离线账号：屏蔽联机相关能力的提示由 UI 负责；参数层面仅需正确的 uuid/token
  const args = [...jvmArgs, version.mainClass, ...gameArgs];

  return {
    command: java.path,
    args,
    cwd: paths.instanceGameDir(instance.slug),
    env: { ...process.env, JAVA_TOOL_OPTIONS: undefined },   // 避免外部 JAVA_TOOL_OPTIONS 干扰
  };
}

/** 规则求值：allow 列表内全部命中才算允许，deny 命中即拒绝 */
export function rulesAllow(rules: Rule[] | undefined, features: Record<string, boolean>, os: OsInfo): boolean {
  if (!rules?.length) return true;
  let allowed = false;
  for (const r of rules) {
    const osOk =
      (!r.os?.name || r.os.name === os.name) &&
      (!r.os?.arch || r.os.arch === os.arch) &&
      (!r.os?.version || new RegExp(r.os.version).test(os.version));
    const featOk = !r.features || Object.entries(r.features).every(([k, v]) => !!features[k] === v);
    if (osOk && featOk) {
      if (r.action === 'deny') return false;
      allowed = true;
    }
  }
  return allowed;
}

function expandArgs(entries: ArgEntry[], features: Record<string, boolean>, os: OsInfo, vars: Record<string, string>) {
  const out: string[] = [];
  for (const e of entries) {
    if (typeof e === 'string') { out.push(substitute(e, vars)); continue; }
    if (!rulesAllow(e.rules, features, os)) continue;
    const values = Array.isArray(e.value) ? e.value : [e.value];
    out.push(...values.map(v => substitute(v, vars)));
  }
  return out;
}

/** ${...} 替换；未知占位符保留原样，方便日志定位 */
function substitute(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\$\{([^}]+)\}/g, (m, k) => vars[k] ?? m);
}

function buildClasspath(version: ResolvedVersion, paths: GamePaths) {
  const libs = mergeLibraries(version.json.libraries)
    .filter(l => !l.natives && l.downloads?.artifact)
    .map(l => paths.library(l.downloads!.artifact!.path ?? mavenToPath(l.name)));
  return [...libs, paths.versionJar(version.id)].join(path.delimiter);
}
```

**启动后处理**：

```ts
// packages/core/launch/process.ts
export function launch(cmd: ReturnType<typeof buildLaunchCommand>, onLog: (l: string) => void) {
  const child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env, windowsHide: false });

  const timer = setTimeout(() => onLog('[launcher] 已启动 5 分钟无输出，可能卡在资源加载'), 300_000);
  child.stdout.on('data', b => onLog(b.toString()));
  child.stderr.on('data', b => onLog(b.toString()));

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (code === 0) return onExit('normal');
    if (code === 1 && /Could not find or load main class/.test(lastLog)) return onExit('classpath');
    if (signal === 'SIGTERM') return onExit('killed');
    onExit('crash', collectCrashReport());   // 读取 crash-reports/*.txt 摘要
  });
  return { pid: child.pid, kill: () => child.kill('SIGTERM') };
}
```

---

## 10. 账号系统

```ts
// packages/core/auth/microsoft.ts
const CLIENT_ID = '00000000402b5328';   // 微软官方启动器 client id；也可注册自有 AAD 应用
const SCOPE = 'XboxLive.signin offline_access';

export class MicrosoftAuthService {
  /** 设备码流程：无需本地回环端口，最适合桌面端（设计稿 05 的"使用 Microsoft 登录"） */
  async begin(): Promise<{ userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }> {
    const r = await postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
      client_id: CLIENT_ID, scope: SCOPE,
    });
    if (!r.ok) throw errors.create('E_AUTH_DEVICE_CODE', '无法发起微软登录');
    const j = await r.json();
    return { userCode: j.user_code, verificationUri: j.verification_uri, deviceCode: j.device_code, interval: j.interval ?? 5, expiresIn: j.expires_in };
  }

  /** 轮询直到用户完成授权；UI 展示 user_code 并提供复制/打开浏览器 */
  async poll(d: { deviceCode: string; interval: number; expiresIn: number }): Promise<MinecraftAccount> {
    const deadline = Date.now() + d.expiresIn * 1000;
    while (Date.now() < deadline) {
      await sleep(d.interval * 1000);
      const res = await postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        client_id: CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.deviceCode,
      });
      const j = await res.json();
      if (j.error === 'authorization_pending') continue;
      if (j.error === 'slow_down') { d.interval += 2; continue; }
      if (j.error) throw errors.create('E_AUTH_DENIED', '登录未完成或被取消');
      return this.finish(j.access_token, j.refresh_token, j.expires_in);
    }
    throw errors.create('E_AUTH_TIMEOUT', '登录超时，请重试');
  }

  /** MSA → Xbox Live → XSTS → Minecraft Services → profile */
  private async finish(msAccess: string, refresh: string, expiresIn: number): Promise<MinecraftAccount> {
    const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccess}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    });

    const xstsRes = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    }, { throwOnError: false });

    if (!xstsRes.ok && xstsRes.body?.XErr) {
      // 这些 XErr 在设计稿里要有明确文案，而不是"登录失败"
      const map: Record<string, string> = {
        '2148916233': '该微软账号尚未创建 Xbox 档案，请先在 xbox.com 完成创建',
        '2148916235': '该账号所在地区不支持 Xbox Live',
        '2148916238': '未成年账号需要先加入家庭组',
      };
      throw errors.create('E_XBOX_PROFILE', map[String(xstsRes.body.XErr)] ?? 'Xbox 授权失败');
    }

    const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${xbl.DisplayClaims.xui[0].uhs};${xstsRes.body.Token}`,
    });

    const profile = await getJson('https://api.minecraftservices.com/minecraft/profile', {
      Authorization: `Bearer ${mc.access_token}`,
    });
    if (!profile.ok) throw errors.create('E_NO_MINECRAFT', '该账号未拥有 Minecraft: Java Edition');

    return {
      id: profile.body.id,
      name: profile.body.name,
      type: 'microsoft',
      tokens: { accessToken: mc.access_token, refreshToken: refresh, expiresAt: Date.now() + (expiresIn - 120) * 1000 },
    };
  }

  /** 静默续期：Minecraft access token 24h，refresh token 90d 滚动更新 */
  async refresh(acc: Account): Promise<Account> {
    if (!acc.tokens?.refreshToken) throw errors.create('E_AUTH_EXPIRED', '登录已过期，请重新登录');
    if (acc.tokens.expiresAt > Date.now()) return acc;
    const j = await postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: acc.tokens.refreshToken, scope: SCOPE,
    }).then(r => r.json());
    if (j.error) throw errors.create('E_AUTH_EXPIRED', '登录已过期，请重新登录');
    return this.finish(j.access_token, j.refresh_token ?? acc.tokens.refreshToken, j.expires_in);
  }
}
```

```ts
// packages/core/auth/offline.ts
import crypto from 'node:crypto';

/** 与 Java 端 UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8)) 完全一致 */
export function offlineUuid(name: string): string {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;   // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80;   // variant
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createOfflineAccount(name: string): Account {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw errors.create('E_INVALID_NAME', '用户名需 3-16 位字母、数字或下划线');
  return { id: offlineUuid(name), name, type: 'offline' };
}
```

**凭据存储**：`safeStorage.encryptString()`（Windows DPAPI / macOS Keychain / Linux libsecret）后写 `accounts.json` 的 `enc` 字段；渲染进程永远拿不到 refresh token，登录态判断走主进程 `auth:status`。

---

## 11. 整合包：下载、解压、依赖补全与冲突

### 11.1 Modrinth（`.mrpack`）

```ts
// packages/core/modpack/mrpack.ts
export interface MrpackIndex {
  formatVersion: 1;
  game: 'minecraft';
  versionId: string;
  name: string;
  dependencies: { minecraft: string; 'fabric-loader'?: string; 'forge'?: string; 'neoforge'?: string; 'quilt-loader'?: string };
  files: {
    path: string;
    hashes: { sha1: string; sha512: string };
    env?: { client?: 'required' | 'optional' | 'unsupported'; server?: string };
    downloads: string[];
    fileSize: number;
  }[];
}

export async function installMrpack(zipPath: string, inst: InstanceConfig, deps: InstallDeps) {
  const zip = await ZipUtil.open(zipPath);
  const index: MrpackIndex = JSON.parse(await zip.readText('modrinth.index.json'));

  // 1) 先由 dependencies 推导 loader，再走标准 loader 安装
  inst.gameVersion = index.dependencies.minecraft;
  inst.loader = loaderFromDeps(index.dependencies);

  // 2) 整合包内文件：直接按 path 落盘（mods/、config/、resourcepacks/…）
  const tasks = index.files
    .filter(f => f.env?.client !== 'unsupported')
    .map(f => ({
      url: f.downloads[0],
      mirrors: f.downloads.slice(1),
      dest: path.join(deps.gameDir, f.path),
      sha1: f.hashes.sha1,
      size: f.fileSize,
      label: path.basename(f.path),
    }));
  await deps.pool.run(tasks, deps.onProgress);

  // 3) overrides/ 与 client-overrides/ 覆盖到实例目录
  await zip.extractDir('overrides', deps.gameDir);
  await zip.extractDir('client-overrides', deps.gameDir);

  inst.source = { provider: 'modrinth', projectId: '', versionId: index.versionId };
  return index;
}
```

### 11.2 CurseForge（`manifest.json`）

```ts
// packages/core/modpack/curseforge.ts
export async function resolveCurseFile(projectId: number, fileId: number, apiKey: string) {
  // 官方 API 需要 key；无 key 时用 CDN 规则拼： /files/<id前4位>/<id后3位>/<filename>
  const r = await getJson(`https://api.curseforge.com/v1/mods/${projectId}/files/${fileId}/download-url`, {
    'x-api-key': apiKey,
  }).catch(() => null);
  if (r?.body?.data) return r.body.data as string;
  throw errors.create('E_CF_NO_KEY', 'CurseForge 需要配置 API Key，或改用 Modrinth 源');
}
```

### 11.3 依赖补全 + 冲突检测

```ts
// packages/core/modpack/resolver.ts
export interface ModVersion {
  projectId: string;
  versionId: string;
  name: string;
  fileName: string;
  loaders: string[];
  gameVersions: string[];
  dependencies: { projectId: string; versionId?: string; type: 'required' | 'optional' | 'incompatible' | 'embedded' }[];
}

export interface ResolveResult {
  installOrder: ModVersion[];           // 已拓扑排序
  missing: { projectId: string; reason: string }[];
  conflicts: { level: 'error' | 'warn'; message: string; mods: string[] }[];
  warnings: string[];
}

/**
 * 三方整合包常见坑：文件里已经带了 Flywheel，但 manifest 没声明；
 * 或整合包作者锁了旧版本而依赖声明了新版。这里做三件事：
 *  1) 递归补齐 required 依赖（带环检测）
 *  2) 同一 project 多版本 → error（保留显式声明的那个）
 *  3) incompatible 边、loader/gameVersion 不匹配 → error/warn
 */
export function resolve(root: ModVersion[], universe: Map<string, ModVersion[]>, target: { loader: string; gameVersion: string }): ResolveResult {
  const chosen = new Map<string, ModVersion>();
  const order: ModVersion[] = [];
  const missing: ResolveResult['missing'] = [];
  const conflicts: ResolveResult['conflicts'] = [];
  const visiting = new Set<string>();

  const pick = (projectId: string, wantVersionId?: string): ModVersion | null => {
    const list = universe.get(projectId) ?? [];
    if (!list.length) return null;
    const candidates = list.filter(v =>
      v.loaders.includes(target.loader) && v.gameVersions.includes(target.gameVersion));
    if (!candidates.length) return null;
    return candidates.find(v => v.versionId === wantVersionId) ?? candidates[0];
  };

  const walk = (mod: ModVersion) => {
    if (visiting.has(mod.projectId)) return;              // 环
    if (chosen.has(mod.projectId)) {
      const prev = chosen.get(mod.projectId)!;
      if (prev.versionId !== mod.versionId) {
        conflicts.push({
          level: 'error',
          mods: [prev.name, mod.name],
          message: `${mod.name} 存在多个版本（${prev.versionId} / ${mod.versionId}），需要二选一`,
        });
      }
      return;
    }
    if (!mod.loaders.includes(target.loader)) {
      conflicts.push({ level: 'warn', mods: [mod.name], message: `${mod.name} 不支持 ${target.loader} 加载器` });
    }
    visiting.add(mod.projectId);
    chosen.set(mod.projectId, mod);

    for (const dep of mod.dependencies) {
      if (dep.type === 'incompatible') {
        const other = chosen.get(dep.projectId);
        if (other) conflicts.push({ level: 'error', mods: [mod.name, other.name], message: `${mod.name} 与 ${other.name} 互斥` });
        continue;
      }
      if (dep.type !== 'required') continue;
      const resolved = pick(dep.projectId, dep.versionId);
      if (!resolved) {
        missing.push({ projectId: dep.projectId, reason: `缺少 ${mod.name} 的前置（${dep.versionId ?? '任意版本'}）` });
        continue;
      }
      walk(resolved);
    }
    visiting.delete(mod.projectId);
    order.unshift(mod);                                   // 前置先装
  };

  root.forEach(walk);
  return { installOrder: order, missing, conflicts, warnings: [] };
}
```

设计稿 04 的冲突横幅就对应 `conflicts` + `missing` 的渲染：`error` 用琥珀色横幅（如 `OptiFine` 与 `Sodium` 渲染管线互斥），逐条给出"停用 / 换版本 / 忽略"三个动作。

---

## 12. 异常处理矩阵

| 错误码 | 触发点 | 用户可见文案 | 自动恢复策略 |
|---|---|---|---|
| `E_MANIFEST_UNAVAILABLE` | 首次拉清单失败且无缓存 | 无法连接到版本服务器 | 退避 3 次；仍失败则引导检查代理/镜像 |
| `E_DOWNLOAD_FAILED` | 单文件三次重试仍失败 | 「xxx.jar 下载失败」+ 重试 | 切镜像源，续传 `.part` |
| `E_HASH_MISMATCH` | SHA-1 与清单不符 | 文件校验不通过，已重新下载 | 删除脏文件重下，最多 3 轮 |
| `E_ASSET_CORRUPT` | 资源对象损坏 | 资源文件损坏 | 只补该 hash，不影响其他文件 |
| `E_EXTRACT_FAILED` | natives/zip 解压异常 | 依赖解压失败 | 清空 natives 目录重解压 |
| `E_JAVA_MISSING` | 未探测到运行时 | 未找到 Java，可自动下载 | 提供受管 JRE 一键安装 |
| `E_JAVA_VERSION_MISMATCH` | major 不足 | 需要 Java 21，当前 17 | 指向可下载的受管运行时 |
| `E_AUTH_EXPIRED` | refresh 失败 | 登录已过期，请重新登录 | 静默刷新；失败才弹窗 |
| `E_XBOX_PROFILE` | XSTS XErr | 按 XErr 给出具体原因 | 无（需用户操作） |
| `E_MOD_CONFLICT` | 依赖解析 | 2 处依赖异常，可能导致启动失败 | 提供"一键停用冲突项" |
| `E_GAME_CRASH` | 子进程非 0 退出 | 游戏异常退出，已保存日志 | 抓 crash-report，高亮 Caused by |

统一形态：

```ts
// packages/core/errors.ts
export class NovaError extends Error {
  constructor(
    public code: string,
    message: string,
    public cause?: unknown,
    public retryable = false,
    public context?: Record<string, unknown>,
  ) { super(message); }
}

export const errors = {
  create: (code: string, message: string, ctx?: Record<string, unknown>) => new NovaError(code, message, undefined, false, ctx),
  wrap: (code: string, cause: unknown, message: string) => new NovaError(code, message, cause, true),
};
```

渲染层只认 `code`，文案走 i18n 表，避免把英文栈抛给玩家。

---

## 13. 跨平台要点

| 事项 | 处理 |
|---|---|
| 路径分隔符 | 一律 `path.join`；classpath 用 `path.delimiter`（`;` / `:`） |
| 窗口 | Windows 用自绘标题栏 + `-webkit-app-region: drag`；macOS 用 `titleBarStyle: 'hiddenInset'`，红绿灯左置 |
| 单实例 | `app.requestSingleInstanceLock()`，二次启动聚焦已有窗口 |
| 进程终止 | `SIGTERM`；Windows 上 `taskkill /pid /T /F` 兜底，避免 java 子进程残留 |
| Java 路径 | 探测顺序差异化（注册表 / java_home / update-alternatives），见 §8 |
| 文件锁 | 实例目录写 `.lock`，防止两个实例同时写同一 `mods/` |
| 高 DPI | `app.commandLine.appendSwitch('high-dpi-support','1')` |
| 主题 | 渲染层读 `nativeTheme.shouldUseDarkColors`，跟随系统时监听 `updated` 事件 |

---

## 14. 性能与可测试性

- **冷启动**：主进程只做路径解析 + 读 `config.json`；清单与实例列表在窗口 `ready-to-show` 后异步加载，首帧 < 300 ms。
- **资源索引**：3000+ 小文件用 8 并发 + 哈希命中跳过；同一份 `assets/objects` 被所有实例共享，多实例不重复占盘。
- **下载节流**：进度回调 120 ms 合并，避免 IPC 洪泛（设计稿侧边栏进度条不掉帧）。
- **单测**：`packages/core` 全部纯函数化 —— `rulesAllow`、`expandArgs`、`offlineUuid`、`resolve`（依赖图）用固定 JSON 快照测试；`DownloadPool` 用本地 `http` 起假源测重试与哈希失败路径。
- **安全**：`contextIsolation: true`、`sandbox: true`、CSP 禁 `unsafe-eval`；所有下载 URL 校验协议白名单（https + 已知域名）；zip 解压做路径穿越检查（拒绝 `../`）。

---

## 15. 落地顺序

1. **M1（可跑）**：Manifest + 原版安装 + Java 探测 + 启动 —— 打通"选版本 → 下载 → 进游戏"。
2. **M2（可用）**：实例 CRUD + 每实例配置 + 离线账号 + 主题。
3. **M3（好玩）**：微软登录 + Fabric/Forge 安装 + Modrinth 整合包与依赖补全。
4. **M4（稳）**：完整性校验、崩溃日志解析、镜像与断点续传、自动化测试。
5. **M5（发布）**：三平台打包、自动更新（`electron-updater`）、崩溃上报。

---

### 附：设计稿 → 代码的对应关系

| 设计稿元素 | 代码位置 |
|---|---|
| 版本表格的"类型/发布日期/运行时" | `VersionSummary.type / releaseTime` + `javaVersion.majorVersion` |
| 侧边栏下载进度条 | `DownloadPool` 的 `ProgressEvent` |
| 实例卡片的"184 个模组 · 8 GB" | `InstanceConfig.mods.length / memory.maxMb` |
| 冲突横幅 | `resolve().conflicts` |
| 账号"令牌有效期" | `Account.tokens.expiresAt` |
| 设置页"BMCLAPI 镜像 · 8 并发" | `config.mirror` + `DownloadPool.concurrency` |
