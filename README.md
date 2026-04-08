# Update Server

通用的应用服务端，当前同时承担：
- 应用更新管理
- 待办同步
- 共享点菜台接口
- 共享相册接口
- 用户注册登录、会话和权限
- 兼容 `stock-viewer / StockPilot` 的 JWT 登录态

## 支持的平台

| 平台 | 包格式 |
|------|--------|
| `android` | `.apk`, `.aab` |
| `electron-win` | `.exe`, `.msi` |
| `electron-mac` | `.dmg`, `.zip` |
| `electron-linux` | `.AppImage`, `.deb`, `.rpm` |
| `ios` | `.ipa` |

## 快速启动

### 本地开发

```bash
cp .env.example .env
# 编辑 .env 中的 ADMIN_API_KEY、BASE_URL、AUTH_SESSION_HOURS、JWT_SECRET、MySQL 和可选 COS 配置
npm install
npm run dev
```

### Docker 部署

```bash
cp .env.example .env
# 编辑 .env：
#   ADMIN_API_KEY=你的密钥
#   SYNC_API_TOKEN=给移动端/其他项目同步待办使用的密钥
#   BASE_URL=https://your-domain.com

docker compose up -d --build
```

## API 文档

### 用户认证

#### 注册

```bash
curl -X POST "https://your-domain.com/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "displayName": "Alice",
    "password": "123456"
  }'
```

#### 登录

```bash
curl -X POST "https://your-domain.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "123456"
  }'
```

返回值里会带 `session.token`。后续请求使用：
- Header：`X-Session-Token`
- 或 Query：`auth_token=...`

第一个注册的用户会自动成为 owner，拥有全部菜单权限。

### 与 Stock Viewer 共用登录

如果你的 `album-cloud` 想直接复用 `stock-viewer / StockPilot` 的登录用户：

- `stock-viewer` 和 `common-server` 需要连到同一个 MySQL
- 两边要使用同一个 `JWT_SECRET`
- `album-cloud` 前端把 `VITE_STOCK_AUTH_API_BASE` 指向 `stock-viewer` 后端

这样 `album-cloud` 登录时会直接拿 `stock-viewer` 的 JWT，而 `common-server` 会识别这枚 JWT 并允许访问相册接口。

### 公开接口

#### 检查最新版本

```
GET /api/apps/:appId/releases/latest?platform=android
```

响应示例：

```json
{
  "version": "1.0.6",
  "url": "https://your-domain.com/api/apps/tool-app/releases/1.0.6/download?platform=android",
  "changelog": "修复已知问题，优化性能",
  "filesize": 12345678,
  "forceUpdate": false,
  "createdAt": "2026-03-15T10:00:00.000Z"
}
```

#### 下载安装包

```
GET /api/apps/:appId/releases/:version/download?platform=android
```

### 管理接口（需要 API Key）

所有管理接口需要在请求头中携带 `X-API-Key`。

#### 上传新版本

```bash
curl -X POST https://your-domain.com/api/apps/tool-app/releases \
  -H "X-API-Key: your-admin-key" \
  -F "file=@app-release.apk" \
  -F "version=1.0.6" \
  -F "platform=android" \
  -F "changelog=修复已知问题" \
  -F "forceUpdate=0"
```

#### 查看版本列表

```bash
curl https://your-domain.com/api/apps/tool-app/releases?limit=20&offset=0 \
  -H "X-API-Key: your-admin-key"
```

#### 删除版本

```bash
curl -X DELETE https://your-domain.com/api/apps/tool-app/releases/1.0.5?platform=android \
  -H "X-API-Key: your-admin-key"
```

### 待办同步接口（需要 Sync Token）

同步接口和版本管理接口分开鉴权，请在请求头里带 `X-Sync-Token`，不要把管理员 `X-API-Key` 暴露给客户端。

#### 拉取当前待办列表

```bash
curl "https://your-domain.com/api/sync/todos" \
  -H "X-Sync-Token: your-sync-token"
```

#### 新增待办

```bash
curl -X POST "https://your-domain.com/api/sync/todos" \
  -H "Content-Type: application/json" \
  -H "X-Sync-Token: your-sync-token" \
  -d '{
    "id": "todo_1",
    "text": "晚上买牛奶",
    "completed": false,
    "createdAt": "2026-03-25T10:00:00.000Z",
    "sourceApp": "tool-app",
    "updatedAt": "2026-03-25T10:00:00.000Z"
  }'
```

#### 更新待办状态

```bash
curl -X PATCH "https://your-domain.com/api/sync/todos/todo_1" \
  -H "Content-Type: application/json" \
  -H "X-Sync-Token: your-sync-token" \
  -d '{
    "completed": true,
    "sourceApp": "tool-app"
  }'
```

#### 删除待办

```bash
curl -X DELETE "https://your-domain.com/api/sync/todos/todo_1" \
  -H "Content-Type: application/json" \
  -H "X-Sync-Token: your-sync-token" \
  -d '{
    "sourceApp": "tool-app"
  }'
```

#### 历史待办导入

```bash
curl -X POST "https://your-domain.com/api/sync/todos/import" \
  -H "Content-Type: application/json" \
  -H "X-Sync-Token: your-sync-token" \
  -d '{
    "sourceApp": "tool-app",
    "items": [
      {
        "id": "todo_1",
        "text": "晚上买牛奶",
        "completed": false,
        "createdAt": "2026-03-25T10:00:00.000Z",
        "updatedAt": "2026-03-25T10:00:00.000Z",
        "deletedAt": null
      }
    ]
  }'
```

现在待办接口是服务端主数据模式：新增、完成、删除都直接落数据库；`/import` 只用于第一次把旧本地数据补传上云。多个项目只要共用同一个 `SYNC_API_TOKEN`，就会操作同一套待办数据。

### 共享相册接口

#### 拉取共享相册工作区

```
GET /api/gallery/bootstrap
```

返回相册列表、媒体文件、评论、分享链接和当前存储模式（本地或 COS）。

#### 新建相册

```bash
curl -X POST "https://your-domain.com/api/gallery/albums" \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: your-session-token" \
  -d '{
    "name": "旅行",
    "description": "2026 春天出门",
    "visibility": "shared"
  }'
```

#### 上传图片/视频

```bash
curl -X POST "https://your-domain.com/api/gallery/assets/upload" \
  -H "X-Session-Token: your-session-token" \
  -F "albumId=album_default" \
  -F 'items=[{"caption":"","width":4032,"height":3024,"durationSeconds":null,"takenAt":"2026-04-07T12:00:00.000Z"}]' \
  -F "files=@/path/to/photo.jpg"
```

说明：
- 服务端不会压缩图片或视频，默认按原文件保存
- 未配置 COS 时落本地 `UPLOAD_DIR`
- 配好 COS 环境变量后自动切到腾讯云对象存储

#### 生成公开分享链接

```bash
curl -X POST "https://your-domain.com/api/gallery/albums/:albumId/share-links" \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: your-session-token" \
  -d '{
    "title": "家庭周末相册",
    "permission": "contributor",
    "allowDownload": true,
    "expiresInHours": 24
  }'
```

说明：
- `permission=contributor`：拿到链接的人可查看并上传
- `permission=viewer`：拿到链接的人只能查看
- 默认有效期 24 小时，最长 30 天

#### 撤销公开分享链接

```bash
DELETE /api/gallery/share-links/:linkId
```

#### 收藏 / 取消收藏

```bash
PATCH /api/gallery/assets/:assetId/favorite
```

#### 更新共享相册成员

```bash
PUT /api/gallery/albums/:albumId/members
```

成员角色支持：
- `viewer`：可看、可下载、可评论
- `editor`：额外可上传、可删除文件

#### 评论媒体

```bash
POST /api/gallery/comments
```

#### 预览 / 下载媒体文件

```
GET /api/gallery/assets/:assetId/file
GET /api/gallery/assets/:assetId/file?download=1
```

#### 整册 / 批量打包下载

```
GET /api/gallery/albums/:albumId/archive
GET /api/gallery/albums/:albumId/archive?assetId=asset_a&assetId=asset_b
```

返回 ZIP 文件，压缩包内会自动按 `photos/` 和 `videos/` 分组。

#### 公开分享页工作区

```
GET /api/gallery/share/:token/bootstrap
```

返回公开分享页所需的相册信息、媒体文件、评论、分享权限和存储信息。

#### 公开链接协作上传

```bash
curl -X POST "https://your-domain.com/api/gallery/share/:token/assets/upload" \
  -F "visitorName=小陈" \
  -F 'items=[{"caption":"海边","width":4032,"height":3024,"durationSeconds":null,"takenAt":"2026-04-07T12:00:00.000Z"}]' \
  -F "files=@/path/to/photo.jpg"
```

说明：
- 链接未过期且权限为 `contributor` 时允许上传
- 上传后会立刻反映到拥有者工作台与公开分享页

#### 公开链接预览 / 下载 / 打包下载

```
GET /api/gallery/share/:token/assets/:assetId/file
GET /api/gallery/share/:token/assets/:assetId/file?download=1
GET /api/gallery/share/:token/archive
GET /api/gallery/share/:token/archive?assetId=asset_a&assetId=asset_b
```

### 腾讯云 COS 环境变量

```bash
COS_SECRET_ID=
COS_SECRET_KEY=
COS_BUCKET=
COS_REGION=
COS_PUBLIC_DOMAIN=
COS_PATH_PREFIX=shared-gallery
COS_SIGNED_URL_EXPIRES=900
AUTH_SESSION_HOURS=720
```

含义：
- `COS_BUCKET`：桶名，格式通常类似 `bucket-1250000000`
- `COS_REGION`：地域，例如 `ap-guangzhou`
- `COS_PUBLIC_DOMAIN`：如果你配了自定义访问域名可以填，不填会走默认 COS 域名

## 多应用接入

每个应用使用独立的 `appId` 命名空间：

| 应用 | appId | 示例 URL |
|------|-------|----------|
| 工具集 | `tool-app` | `/api/apps/tool-app/releases/latest?platform=android` |
| 账单 | `bill-app` | `/api/apps/bill-app/releases/latest?platform=android` |
| 桌面应用 | `my-electron` | `/api/apps/my-electron/releases/latest?platform=electron-win` |

## Electron 接入示例

```javascript
const { autoUpdater } = require("electron-updater");

async function checkForUpdates() {
  const res = await fetch(
    "https://your-domain.com/api/apps/my-electron/releases/latest?platform=electron-win"
  );
  const data = await res.json();
  // data.url 即为下载地址
}
```

## 健康检查

```
GET /health
```
