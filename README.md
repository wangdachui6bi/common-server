# Update Server

通用的应用更新管理服务，支持多应用、多平台的版本管理与包分发。

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
# 编辑 .env 中的 ADMIN_API_KEY 和 BASE_URL
npm install
npm run dev
```

### Docker 部署

```bash
cp .env.example .env
# 编辑 .env：
#   ADMIN_API_KEY=你的密钥
#   BASE_URL=https://your-domain.com

docker compose up -d --build
```

## API 文档

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
