# LINUXDO 木鱼

一个极简黑白的 Discourse 电子木鱼小程序。登录社区后，功德与私密祈福跟随账号保存至 Cloudflare D1，支持多设备同步、离线待同步缓存和幂等重试。

## 功能

- 点击、触摸或空格键敲击，木鱼动画、真实木鱼音效和功德飘字。
- 今日功德、累计功德跟随社区账号，游客只显示登录提示。
- 私密祈福：108 / 1008 / 10080 次目标，从许愿后的新增功德计算，完成后保留记录。
- 不发布帖子、不评论、不公开祈福内容。
- Cloudflare Worker 严格验证平台 JWT，D1 原子累计与批次幂等防止重试重复计数。
- 本地保存待同步数据；同步失败暂停新增计数，恢复后使用原批次重试。
- 深浅主题、减少动效、窄屏、键盘及全屏支持。

## 仓库结构

```text
app/                 Discourse 小程序、素材与前端测试
worker/              Cloudflare Worker、D1 迁移与后端测试
sdk/                 本地官方 SDK，已在 .gitignore 中排除
docs/                通用架构与开发文档
```

官方 `discourse-mini-app-guidelines`、个人 Cloudflare 教程、部署配置和凭据不进入公开仓库。不要将 `.dev.vars`、`wrangler.local.toml`、平台 JWT 或 API Token 发送到 issue。

## 本地开发

需要 Bun 1.4.3+。首先从官方渠道取得 Discourse Mini App SDK，将开发包中的 `sdk/` 目录放在仓库根目录，与 `app/` 和 `worker/` 同级。SDK 没有上传到此仓库。

```sh
cd app
bun install
bun run dev
```

访问 `http://127.0.0.1:5194/`。普通浏览器预览用于界面和业务逻辑；生产构建不会使用内置预览账号或浏览器网络能力。

真实 `user.read`、`network.request`、JWT 和 sandbox 隔离必须在 Discourse sandbox 验证。不能把预览模式当作生产登录或权限测试。

## 测试与打包

```sh
cd app
bun run typecheck
bun run test
bun run build

cd ../worker
bun install
bun run typecheck
bun run test
```

Worker 的部署、D1 迁移与环境配置见 `worker/README.md`。构建小程序时按环境传入应用 ID、版本和 Worker HTTPS Origin，禁止直接使用 manifest 中的文档示例值发布。

```sh
cd app
MINI_APP_ID=平台应用ID \
MINI_APP_VERSION=1.0.0 \
MINI_APP_API_ORIGIN=https://你的Worker域名 \
bun run build
```

PowerShell：

```powershell
$env:MINI_APP_ID = "平台应用ID"
$env:MINI_APP_VERSION = "1.0.0"
$env:MINI_APP_API_ORIGIN = "https://你的Worker域名"
bun run build
```

上传 `app/dist/package/app.zip`。应用必须申请 `user.read`、`network.request`、`theme.read`、本地存储、音频与全屏权限，不包含其他用户查询、论坛发帖、WebSocket 或 CDN 权限。

## CI

Push 与 pull request 会在 instabox 上运行前端测试、Worker 测试、应用 ZIP 构建和 Worker dry-run。配置见 [CI 文档](docs/CI.md)。官方 SDK 从固定公开提交恢复并逐文件校验，无需在 CI 中保存 SDK 归档或 Cloudflare 凭据。

## 数据与隐私

- 云端以验签后的 `(iss, sub)` 确认账号，不信任客户端提交的 `userId`。
- 正式和 sandbox 使用不同 D1 数据库，不共享功德或祈福。
- 祈福仅本人可见，不上传公开评论区。
- 首版不提供云端功德清零，防止其他设备的旧离线增量重新写回。
- 音效为 CC0 真实木鱼录音；完整来源和修改记录见 `THIRD_PARTY_NOTICES.md`。

## 开源许可

项目代码采用 [MIT License](LICENSE)。第三方音频的来源、许可和对参考项目的说明见 `app/THIRD_PARTY_NOTICES.md` 及运行包中的 `media/NOTICE.txt`。
