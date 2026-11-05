# NovaMC

一个跨平台（Windows / macOS / Linux）的 Minecraft 启动器，Electron + React + TypeScript。

- 设计稿（Ardot）：https://ardot.tencent.com/file/743492153539132
- 技术方案：见 `NovaMC-技术方案.md`

## 已实现

| 模块 | 说明 |
|---|---|
| 版本管理 | 拉取 `version_manifest_v2.json`，ETag + 6h 缓存，离线回落到旧缓存；按正式版 / 快照 / 旧版筛选；显示发布日期与所需 Java 主版本 |
| 版本安装 | 客户端 jar、依赖库、legacy natives 解压、资源索引 + 资源对象，全程并发下载 + SHA-1 校验 + 镜像回落；分阶段进度、断点续传、完成标记 |
| 实例管理 | 创建 / 重命名 / 删除；游戏版本只能从**本机已安装**的版本里选；每实例独立的存档、模组、Java、内存、分辨率与启动参数 |
| 启动 | 合并 `inheritsFrom` 链、按 rules 求值展开 `arguments.game/jvm`、组装 classpath 与 `${}` 变量，子进程管理与崩溃日志摘要；启动前校验 jar 与依赖库，损坏自动补 |
| Fabric | 通过 fabricmc meta 拉取 profile 并落盘，与父版本合并启动；官方源 + BMCLAPI 双源回退 |
| Forge / NeoForge | 完整安装链：下载 installer → 解析 `install_profile.json` → 下载依赖库 → 执行 processor（解包、BinaryPatch 补丁）→ 产出可启动 jar；BMCLAPI 镜像优先 + 官方源兜底，并发竞速 + 多轮重试 |
| 模组依赖 | 启动前扫 `mods/*.jar` 读 `fabric.mod.json`（含 JiJ 内嵌依赖），比对 `depends` 找出缺失前置；Modrinth 匹配当前游戏版本 + Fabric 后可一键补齐；版本范围对不上时明确提示而不是硬装 |
| 整合包 | Modrinth 搜索 + `.mrpack` 安装（index 解析、文件下载、overrides 覆盖），自动装 Fabric；支持本地 zip 导入（CurseForge / Modrinth / 裸 `.minecraft`），缺版本自动下载 |
| 账号 | 离线账号（UUID v3 与 Java 端一致）、多账号切换。**微软登录按计划推迟** |
| Java | 三平台探测（注册表 / `java_home -V` / `update-alternatives` + 常见目录）；缺失时启动自动下载受管 JRE，优先清华 TUNA 镜像 |
| 皮肤 | 原版 Steve / Alex 默认皮肤，双层（body + overlay）渲染，头像渲染；启动时写入游戏目录 |
| 光影 | 支持一键安装 OptiFine（Forge）/ 光影包，保证 `shaderpacks` 目录存在 |
| 内网穿透 | 内置 frpc，支持樱花（SakuraFrp）/ 幻缘（ME Frp）/ HayFrp；凭据保存、自动拉取隧道、切页不断连、剩余流量/带宽显示、本地端口在线检测、一键复制地址 |
| 在线更新 | GitHub Releases 托管，启动自动检测，标题栏红色 NEW 标识 + 更新弹窗（内容/更新/取消），SHA256 校验后自替换 |
| 界面 | 侧边栏 + 内容区，深色 / 浅色 / 跟随系统，七个页面；设置页为「左侧分区导航 + 单栏内容」，分 7 个分区并支持搜索 |

## 未实现（刻意留白）

- **微软登录**：OAuth 设备码 → Xbox Live → XSTS → Minecraft Services。`Account.type` 与令牌字段已预留，接入时不需要改数据模型。
- **CurseForge 在线搜索/下载**：需要 API Key 与合规授权，当前只接 Modrinth；本地 CurseForge 整合包 zip 导入不受影响。

## 快速开始

```bash
npm install          # 国内网络可加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev          # 开发模式，热更新
npm run build        # 构建到 out/
npm start            # 预览构建产物
npm run typecheck    # 类型检查
npm run package:win  # 打包（mac / linux 同理）
```

### 获取 frpc（内网穿透）

内网穿透功能依赖两份 frpc 二进制，体积较大、且各有独立的第三方来源，故不随源码提交：

| 文件 | 用途 | 来源 |
|---|---|---|
| `resources/frpc/frpc.exe` | 官方 frpc（幻缘 / HayFrp / 通用） | https://github.com/fatedier/frp/releases （选 `frp_<版本>_windows_amd64.zip`，解压后取 `frpc.exe`） |
| `resources/frpc-sakura/frpc.exe` | 樱花定制版 frpc（支持 `-f` 快速启动） | https://www.natfrp.com/ （樱花 Frp 官网提供） |

放好后即可 `npm run dev` 或打包。不玩内网穿透可以先跳过，其余功能不受影响。

首次启动会：拉取版本清单 → 探测本机 Java（没有就自动下载受管 JRE，也可以到「设置 → Java 运行时」手动装）→ 到「实例」新建实例（会自动下载对应版本）。

### 数据目录（绿色版）

打包后的 exe **自带数据目录**：游戏版本、依赖库、资源、受管 Java、实例存档全部写在 exe 同级，
整个文件夹拷到 U 盘或另一台机器直接能用，卸载 = 删文件夹。

```
NovaMC-0.0.1\
├─ NovaMC-0.0.1.exe
├─ versions\  libraries\  assets\  runtime\  instances\  logs\
├─ config.json
└─ .launcher\        Chromium 缓存，不参与业务
```

- 位置由 `PORTABLE_EXECUTABLE_DIR` 决定——portable 版运行时会把自身解压到 `%TEMP%`，
  直接读 `execPath` 会拿到临时目录，写进去退出即丢。
- 启动前会写探针文件确认目录可写；不可写（如放在 `Program Files`、只读 U 盘）则回落到用户目录，
  并在「设置 → 目录与存储」明确提示，不静默失败。
- 开发模式（`npm run dev`）仍用 `%APPDATA%/novamc/NovaMC`，避免把几个 GB 的下载物拉进工程目录。

## 打包单文件 exe

```bash
npm run package:win     # 构建 + 打包，按版本归档到 NovaMC/
```

产物按**版本号各自一个目录**，新版本不会覆盖旧版本：

```
NovaMC/
├─ NovaMC-0.0.0/
│  └─ NovaMC-0.0.0.exe      ← 单文件，约 71 MB
└─ NovaMC-0.0.1/            ← 改完 version 再打包时自动新建
   └─ NovaMC-0.0.1.exe
```

- 目录名与文件名都跟着 `package.json` 的 `version` 走。归档由 `scripts/after-build.js`（electron-builder 的 `afterAllArtifactBuild` 钩子）完成，所以直接调用 `electron-builder` 也会照样归档。
- 中间产物（`win-unpacked`、`builder-debug.yml`）不落在工程里：`scripts/pack.js` 每次在系统临时目录新建输出目录，结束后尽量清理，交付目录里只有 exe。
  这么做是因为 Windows 经常锁住 `win-unpacked/resources/app.asar`，固定输出目录会在下一次打包时 EBUSY 失败。
- 双击即用，不写注册表、不需要安装；运行时自解压到 `%TEMP%`，退出后缓存保留，第二次启动更快。

- 版本号取自 `package.json` 的 `version`，当前为 **0.0.0**。界面侧边栏的 `Launcher 0.0.0` 由构建时注入（`__APP_VERSION__`），不需要手动改文案。
- 图标：`build/icon.ico`（256×256，由 `build/icon.png` 转换；`npm run icon` 可重新生成 png）。
- **未做代码签名**，Windows 首次运行会弹 SmartScreen「未知发布者」，选择「更多信息 → 仍要运行」。
- `win.signAndEditExecutable` 为 `false` 是有意为之：electron-builder 的签名工具链压缩包里含有 macOS 的 dylib 符号链接，在未开启开发者模式（或非管理员）的 Windows 上解压会报 `Cannot create symbolic link`，整条打包流程会中断。portable 的版本信息与图标由 NSIS 直接写入，不受影响。将来接签名时把它打开，并配置 `CSC_LINK` / `CSC_KEY_PASSWORD`。

## 目录

```
src/
├─ core/          # 纯逻辑，零 electron 依赖，可单测
│  ├─ manifest.ts     版本清单（缓存 / ETag / 离线回落）
│  ├─ version.ts      版本解析、inheritsFrom 合并、Fabric 安装
│  ├─ download.ts     并发下载池（哈希校验 / 重试 / 跳过已存在）
│  ├─ installer.ts    安装流水线（client / libraries / natives / assets）
│  ├─ launch.ts       启动参数组装 + 进程管理
│  ├─ java.ts         三平台 Java 探测
│  ├─ javaProvision.ts 受管 JRE 下载与解压
│  ├─ instance.ts     实例存储（instance.json 原子写）
│  ├─ auth.ts         离线账号 + UUID v3
│  ├─ modpack.ts      Modrinth 整合包
│  └─ rules.ts        rule / features 求值
├─ main/          # 主进程：装配 + IPC
├─ preload/       # contextBridge 白名单
└─ renderer/      # React 界面（六页 + 主题）
```

## 排障用命令行开关

| 环境变量 | 作用 |
|---|---|
| `NOVAMC_USER_DATA=<dir>` | 覆盖用户数据目录（测试用，避免污染真实配置） |
| `NOVAMC_SMOKE=<png>` | 启动后截图并退出（视觉回归） |
| `NOVAMC_SMOKE_PAGE=<0-5>` | 截哪个页面：0 主页 / 1 版本 / 2 实例 / 3 整合包 / 4 账号 / 5 设置 |
| `NOVAMC_SMOKE_CLICK=<按钮文字>` | 截图前点一次文字完全匹配的按钮 |
| `NOVAMC_SMOKE_SCRIPT=<js>` | 截图前执行一段脚本，用来切到指定分区 |
| `NOVAMC_INSTALL=<versionId>` | 无界面安装指定版本 |
| `NOVAMC_INSTALL_ABORT=<ms>` | 配合上一条，到点中止 |
| `NOVAMC_PROVISION=<major>` | 无界面安装受管 Java |

## 下载体验上的三个设计

**进度按字节和文件数混合推进。** 只按文件数算：一个 28 MB 的客户端 jar 只算 1 个文件，进度条会长时间停在 0%；只按字节算：资源索引尾部全是几十 KB 的音效文件，字节几乎不动。两个维度各占一半，任何一种工作量都能推动进度条。剩余时间取"按字节"和"按文件"两种估算里更慢的那个。

**安装分五个阶段，各有独立分母。** 解析版本 → 下载客户端 → 依赖库 → 资源文件 → 解压本地库。侧边栏显示 `依赖库 3/5` 与实时速度，不会出现"总量 4000 但刚装完 58 个库"的误导性百分比。

**下载池自带熔断和看门狗。**
- 某个源连续失败 3 次即在本轮不再排队，避免每个文件都先撞一次坏镜像（实测把资源下载从 3.3 文件/秒提到 11 文件/秒）。
- 响应体 20 秒没有新字节、或 25 秒平均速度低于 5 KB/s，直接掐断换源——否则进度会永远停在 99%。
- 资源文件允许失败（缺几个音效不影响进游戏），依赖库和客户端 jar 不允许。

## 已知限制

- 受管 JRE 优先走清华 TUNA 的 Adoptium 镜像（实测 7 MB/s），失败回落官方源。两者都拿不到时提示切换下载源。
- 首次安装现代版本仍需要下载约 400 MB / 4000 个资源对象，耗时取决于带宽与镜像质量。
- 未做自动更新（`electron-updater`）与崩溃上报。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。你可以自由使用、修改、分发，但需保留版权声明与许可声明。
