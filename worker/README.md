# 木鱼 Cloudflare Worker + D1 后端

TypeScript Worker，提供登录用户功德同步与愿望记录。生产代码不依赖 Node.js，也不引用 SDK 的 `server.mjs`；鉴权在 `src/auth.ts` 中使用 WebCrypto 按 SDK 规则独立实现。

## 配置

将 `wrangler.example.toml` 复制为 `wrangler.local.toml`，分别填写 production 和 sandbox 的 D1 ID、应用 ID、外部 HTTPS origin。示例文件不含真实凭据。`PLATFORM_JWKS_URL` 应由对应 issuer 拼接 `/mini-app-api/jwks`，issuer 含论坛子目录时保留该子目录。

| 变量 | 含义 |
| --- | --- |
| `CHANNEL` | 固定接受 `production` 或 `sandbox` token |
| `PLATFORM_ISSUER` | 必须与 token 的 `iss` 完全一致 |
| `PLATFORM_JWKS_URL` | 固定的社区 HTTPS JWKS 地址，不从 JWT 读取 |
| `PLATFORM_AUDIENCE` | 本 Worker 的受信任 HTTPS origin，同时校验 `aud` 和 `htu` |
| `PLATFORM_APP_ID` | 允许调用的应用 ID |
| `APP_VERSION` | 可选；设置后要求完全一致的 token `version` |
| `CORS_ORIGIN` | 唯一允许写入 `Access-Control-Allow-Origin` 的 origin，非 `*` |

JWKS 的 EC P-256 公钥需要带 `kid`，且 `kid` 必须为该公钥 SPKI DER 的 SHA-256 小写十六进制。模块内缓存有效期 5 分钟；未过期直接使用，未知 `kid` 触发的刷新有 30 秒冷却及并发去重。私钥、`jku`、`jwk`、`x5u` 和 `crit` 不会被接受。

外部请求 URL 由 `PLATFORM_AUDIENCE` 和实际 pathname/query 重建，不信任 Host/X-Forwarded-*。除规范 URL 外，还校验 `htm`、`query_keys`、动态 query 字节及 token 的完整时间窗。token `jti` 可以在该端点有效期内复用，功德幂等由业务 `batchId` 保证。

## 本地检查

需要 Bun 1.4.3+：

```sh
bun install
bun run typecheck
bun test test
```

测试使用 `bun:sqlite` 执行同一份 migration 和同一组 SQL。D1 测试适配器的 `batch()` 在 SQLite 事务内同步执行，任一语句失败整体回滚；覆盖签名与绑定矩阵、严格输入、100 次重放、多批并发、愿望封顶、旧愿望隔离和 active 唯一索引。

复制配置后可初始化本地 sandbox D1（不会操作远程资源）：

```sh
bun run d1:migrations:local
bun run dev
```

## API

除 `GET /health` 和 `OPTIONS` 外，都必须带平台签发的 `Authorization: Bearer ...`。CORS 允许 `Authorization, Content-Type`，所有业务 JSON 响应为 `Cache-Control: no-store`。

### `GET /health`

公开返回 `{ "ok": true }`。

### `GET /v1/state?day=YYYY-MM-DD`

日期必须是实际存在的日期，且只能有一个 `day` query。返回：

```json
{
  "revision": 2,
  "total": 108,
  "today": 108,
  "activeWish": null,
  "wishes": [
    {
      "id": "UUID",
      "content": "愿望正文",
      "target": 108,
      "progress": 108,
      "createdAt": "2026-11-06T00:00:00.000Z",
      "completedAt": "2026-11-06T00:01:00.000Z"
    }
  ]
}
```

`today` 是指定 `day` 的功德数，`revision` 每个成功的新功德批次增加一次。`activeWish` 为 `null` 或 Wish 对象，`wishes` 仅包含最近 5 条已完成记录；未完成对象不含 `completedAt`。所有读取均以 `(iss, sub)` 为用户边界。

### `POST /v1/merit/sync`

请求字段必须恰好为：

```json
{
  "batchId": "UUID",
  "delta": 1,
  "day": "2026-11-06",
  "dayDelta": 1,
  "wishId": "UUID 或 null"
}
```

- `delta` 是 1–2000 的整数，`dayDelta` 必须相等；UUID 归一化为小写。
- `wishId` 非 `null` 时，只推进同一用户且 ID 相同、尚未完成的 active wish。
- 进度至多增至 `target`；完成时间只在跨越目标时设置一次。
- 返回与 state 端点相同结构。

同步各项写入和状态读取在同一个 `DB.batch()` 中完成：初始化账号、插入唯一 `(iss, sub, batch_id)`、原子增加 total/daily/revision、推进愿望、读取响应。唯一批次插入**不能**改成忽略冲突，也不能先 SELECT 再 UPDATE。若唯一插入冲突，D1 回滚整个批次，catch 分支仅返回最新状态。

### `POST /v1/wishes?day=YYYY-MM-DD`

`day` 是可选的客户端本地日期；存在时用于本次响应的 `today`，且必须在 token 的 `query_keys` 中。省略时回退到服务端 UTC 日期。

```json
{
  "content": "  愿平安  ",
  "target": 108
}
```

正文 trim 后为 1–80 个 Unicode codepoint，拒绝孤立 surrogate；`target` 只能是 `108`、`1008`、`10080`。请求不能包含 `day` 等额外字段。Wish ID 由服务端生成。返回 `201` 和与 state 端点相同的完整结构，新建愿望位于 `activeWish`，`wishes` 仍仅包含最近 5 条已完成记录；`today` 按服务端当前 UTC 日期读取。

同一用户只能有一个 active wish，由 migration 中的部分唯一索引兜底。并发创建时一个成功，另一个得到 `409 ACTIVE_WISH_EXISTS`。

## 错误

- `400 INVALID_REQUEST`：JSON、日期、字段或 query 不合法。
- `401 INVALID_PLATFORM_REQUEST`：平台身份、签名、时间窗或 URL 绑定失败。
- `409 ACTIVE_WISH_EXISTS`：本用户已有 active wish。
- `404 NOT_FOUND` / `405 METHOD_NOT_ALLOWED`。

错误响应不返回内部 SQL 或鉴权细节。代码不记录 JWT、Authorization header 或愿望正文。
