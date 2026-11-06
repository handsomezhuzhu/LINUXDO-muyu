# 架构说明

## 边界

- 仅登录用户使用功德和祈福；匿名用户得到登录提示，不创建账号记录。
- 小程序通过 Discourse SDK 获取当前用户和受保护 HTTP，不接触论坛 Cookie、父页面或 Cloudflare 管理接口。
- Cloudflare Worker 是唯一的业务与鉴权入口，D1 是唯一账号数据库。
- 祈福是私人数据，不进入社区主题、评论或公开列表。
- 正式与 sandbox 分别使用 Worker 环境和 D1 数据库。

## 数据流

```text
用户敲击
  → 本地立即更新动画与待同步批次
  → sdk.http.request（固定 endpoint，平台 Authorization）
  → Worker 验证 JWT、endpoint 与输入
  → D1 原子写入唯一批次、账号与祈福进度
  → 返回带 revision 的账号状态
  → 客户端确认并删除对应待同步批次
```

客户端只有账号数据的临时视图和尚未确认的批次；它不是云端计数是否成功的权威来源。刷新后通过服务端状态与待同步重放恢复；只有同步成功的批次才能从本地删除。

## 幂等与排序

每个增量批次有 UUID。D1 的唯一批次键与功德/祈福更新组成一个原子事务。网络超时后使用原 UUID 重试；重复批次让整批写入无效，再返回当前状态，而不是继续执行增量更新。

`revision` 随每个有效批次递增。客户端不采用更旧的服务端快照，也不通过覆盖绝对 total 的方式合并多端修改。

## 鉴权

Workers 中使用 WebCrypto 验证 P-256 / ES256，严格核对受信 issuer、audience、应用 ID、channel、权限、HTTP method、外部 URL、动态 query 名和时间窗口。

JWKS 只从配置的固定社区 `/mini-app-api/jwks` 地址读取，并遵循公钥格式、缓存和未知 kid 的刷新约束。客户端不能提供身份，Worker 使用验签后的 `(iss, sub)` 作为账号键。

Node/Bun 专用 SDK 服务端模块不作为 Workers 运行时依赖。

## 祈福

- 正文 trim 后 1–80 个 Unicode code points，服务端再次验证。
- 目标仅为 108、1008、10080。
- 同一账号最多一个 active 祈福。
- 只有创建后明确归属于该祈福的增量批次才推进进度。
- 在累计功德的同一原子事务内封顶、完成并保存时间，不扣除总功德。

## 首版不做

- 公开祈福墙、论坛发帖、评论、他人资料、排行榜。
- 游客云端账号或不同账号的自动合并。
- 云端功德清零。离线设备可能保留旧增量，简单归零会重新加回；若将来支持需先实施 generation。
- 为每次敲击单独发送 HTTP 请求，或预埋 Durable Objects。

## 凭据

Cloudflare 管理 Token、Wrangler login 凭据、本地部署配置和 Discourse JWT 都不是应用资源。不得放入源码、`app.zip`、manifest、日志或 GitHub issue。开源仓库不包含官方 SDK 和个人部署教程。
