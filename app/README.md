# 木鱼 · Discourse 小程序

纯黑白电子木鱼。登录后，今日/累计功德和私密祈福跟随社区账号同步到 Cloudflare D1。支持点击、触摸、空格键、敲击动画、真实木鱼音效、深浅主题、减少动效和全屏。

游客只显示登录提示，不建立游客云数据。

## 本地开发

需要 Bun 1.4.3+。从官方渠道获取 Discourse Mini App SDK，将开发包中的 `sdk/` 目录放到仓库根目录，与 `app/` 同级。SDK 不包含在开源仓库中。

```sh
bun install
bun run dev
```

预览：`http://127.0.0.1:5194/`。普通浏览器预览仅用于界面和业务逻辑；生产构建不包含预览适配器，真实登录、权限、JWT 和 Worker 隔离必须在 Discourse sandbox 验证。

## 检查与构建

```sh
bun run typecheck
bun run test
bun run build
```

传社区分配的应用 ID、递增的三段版本号和 Worker Origin：

```sh
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

只上传 `dist/package/app.zip`。manifest 中的示例应用 ID 和 Worker 地址不得用于发布。普通构建只生成本地候选包，不会上传或部署任何 Cloudflare 资源。

## 素材与许可

- `design/muyu.png`：根据作者提供图片抠出的透明图。
- `design/icon.png`：社区应用页图标。
- `public/images/muyu.webp`：运行时透明图像。
- `public/media/knock.wav`：CC0 真实木鱼录音，裁剪至 420ms。
- `public/media/NOTICE.txt`：随运行 ZIP 分发的音频署名。
- `third_party/mokugyo/`：原始 FLAC 和来源元数据。
- `scripts/prepare-images.py`：重新制作透明图像（Pillow）。
- `scripts/prepare-audio.py`：从原始 FLAC 制作敲击音效（FFmpeg）。
- `THIRD_PARTY_NOTICES.md`：音效许可、来源、修改和参考说明。

项目代码采用根目录的 MIT License。第三方音频保持 CC0 署名。

## 权限与数据

需要 `user.read`、`network.request`、`theme.read`、本地存储、音频和全屏权限，不包含其他用户资料、发帖、WebSocket 或 CDN 权限。

本地仅保留音效偏好和当前登录账号的待同步批次。正式云端数据以验签后的 `(iss, sub)` 归账号所有。同步失败保留批次并暂停新增计数，恢复网络后以原 batchId 重试。首版不提供云端清零，具体边界见根目录 `docs/ARCHITECTURE.md`。
