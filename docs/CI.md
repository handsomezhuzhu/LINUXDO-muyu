# CI（instabox）

工作流位于 `.github/workflows/ci.yml`，在 push、pull request 和手动触发时运行两个独立 job：

- `app`：恢复官方 SDK、逐文件校验、安装依赖、类型检查、前端测试并构建 `app.zip`。
- `worker`：安装依赖、类型检查、鉴权与 D1 测试、Wrangler dry-run。

两个 job 都使用 `runs-on: instabox-medium`。instabox 为每个 job 提供新的 Ubuntu 24.04 机器，任务完成后删除它。没有部署 Cloudflare 或上传社区版本的步骤，也不需要 Cloudflare 凭据。

## 一次性连接 instabox

1. 在 instabox dashboard 打开 **CI**。
2. 选择 **Connect GitHub**，安装 instabox GitHub App，并让它访问 `handsomezhuzhu/LINUXDO-muyu`。
3. 不需要在 workflow 里添加 instabox API key。GitHub App 的权限范围及机器标签以 [官方 CI 文档](https://instabox.sh/docs/ci) 为准。

如果暂时不想安装 GitHub App，可以改用官方文档的“Run the CLI from any CI”方式，但那会需要单独的 instabox API key，并非当前工作流默认路径。

## 官方 SDK 的恢复与校验

SDK 不提交到 Git 仓库，但前端必须取得官方 SDK 才能类型检查和打包。CI 固定下载公开仓库：

```text
https://github.com/linux-do/mapp-developer-guide
```

固定提交：

```text
828a1150f745b6b30abc7f8a3dd9dc1703c73136
```

CI 固定到官方 SDK 0.2.0，兼容应用当前使用的原生 Web Audio 和 `audio.webAudio` 权限。此提交包含 `types.d.ts` 中的 `audio.webAudio`、`types.d.ts` 新权限声明，以及 `pack.mjs` 对同名权限的白名单支持。线上 `master` 若继续演进，构建仍不会在没有复核的情况下自动跟随变化。

CI 从 `.github/sdk-code.sha256` 逐文件验证 8 个 runtime 文件的内容（包含 `types.d.ts`），再提取 `sdk/`。原始教学 ZIP 与公开仓库的 README 仅存在说明文字差异，不把文档命名差异误判成代码被篡改。

所以当前 workflow **不需要任何 SDK Base64 Secret**。此前手工配置的四个 `DISCOURSE_MINI_APP_SDK_ZIP_BASE64_*` Secrets 已不再引用；是否删除可由仓库管理员单独决定，代码不会读取或输出它们。

优点是：

- 没有 SDK 或 Cloudflare 凭据进入 workflow 日志。
- 不依赖 secrets，因此来自 fork 的 pull request 也能运行同一套测试。
- 固定公开提交并校验代码，避免上游更新导致不可重复的构建。

如果要升级 SDK，应单独评估上游新能力与 API 变化，并更新固定提交、SDK fingerprint、应用权限和测试，不能让 CI 无约束地跟踪 master。

## 禁止加入 CI 的内容

- `CLOUDFLARE_API_TOKEN` 或个人 Global API Key
- Discourse 用户 Token、JWT 或登录 Cookie
- `.dev.vars`、`wrangler.local.toml`
- 生产或 sandbox D1 管理凭据
- 本地截图、Wrangler 真实部署状态、SDK 目录本身

CI 的目标只是验证源码与构建，不发布应用、不部署 Worker、不修改 D1。只有在你另行确认后，才考虑独立的 CD 工作流。
