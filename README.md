## 91-download-api

基于 Node.js 的 **M3U8 解析与下载 API 服务**。  
支持：
- **解析页面**获取 M3U8 地址
- **下载并合并 TS 片段**为单一视频文件
- 下载完成后支持多种 **存储方式**：本地、S3、WebDAV、FTP

---

## 功能概览

- **健康检查**：`GET /health`
- **解析页面获取 M3U8**：`POST /api/parse`
- **下载 M3U8 视频**：`POST /api/download`
- **一键流程：解析 + 下载 + 存储**：`POST /api/process`
- **一次性本地下载链接**：`GET /files/:id`

所有 `/api/*` 接口默认启用 **简单 Token 认证**（可通过 `.env` 控制）。

---

## 环境要求

- Node.js **18+**（建议 18 或更新版本，已使用 ES Module 与 `node-fetch`、`puppeteer`）
- 安装 `pnpm` 或 `npm`

---

## 安装与启动

```bash
# 安装依赖（任选其一）
pnpm install
# 或
npm install

# 启动服务
node app.js
```

服务默认监听端口：`3005`，可通过环境变量 `PORT` 修改。

启动成功后终端会输出类似：

- 健康检查：`http://localhost:3005/health`

---

## 环境变量配置（.env）

在项目根目录创建 `.env` 文件，例如：

```ini
PORT=3005

# API 访问 Token（可选，但生产环境强烈推荐配置）
API_TOKEN=your-secret-token

# 本地文件下载链接基础地址（可选）
# 不配置时默认使用当前请求的 protocol + host
DOWNLOAD_BASE_URL=https://your-domain.com
```

- **未配置 `API_TOKEN` 时**：认证中间件会 **自动跳过认证**（方便本地开发）。
- **配置了 `API_TOKEN` 时**：调用 `/api/*` 需在请求头中携带：
  - `x-api-token: your-secret-token`  
  或
  - `Authorization: Bearer your-secret-token`

---

## 接口说明

### 1. 健康检查

- **URL**：`GET /health`
- **说明**：用于检查服务是否正常运行。

示例响应：

```json
{
  "status": "ok",
  "message": "Service is running"
}
```

---

### 2. 页面解析：获取 M3U8 URL

- **URL**：`POST /api/parse`
- **认证**：需要（取决于 `API_TOKEN` 配置）
- **请求体**：

```json
{
  "url": "https://hsex.men/..." 
}
```

> 当前仅支持 `host === 'hsex.men'`，否则会返回错误。

**成功响应示例**：

```json
{
  "success": true,
  "result": [
    "https://example.com/path/to/file.m3u8"
  ],
  "title": "页面标题（如果解析到）"
}
```

**失败响应示例**：

```json
{
  "success": false,
  "error": "Invalid Host",
  "errmsg": "Expected host 'hsex.men', got '...'"
}
```

---

### 3. 下载 M3U8 视频

- **URL**：`POST /api/download`
- **认证**：需要
- **请求体**：

```json
{
  "m3u8Url": "https://example.com/file.m3u8",
  "outputDir": "data",       // 可选，默认 data
  "storage": {               // 可选，存储配置，见下文
    "type": "local"
  }
}
```

**关键字段说明**：

- `m3u8Url`：必填，指向有效的 `.m3u8` 文件 URL。
- `outputDir`：可选，相对项目根目录的输出目录（默认 `data`）。
- `storage`：可选，下载完成后的存储策略：
  - `local`：仅保留本地文件，并返回可注册的路径
  - `s3`：上传到 S3 或兼容存储
  - `webdav`：上传到 WebDAV
  - `ftp`：上传到 FTP

**成功响应示例**（本地存储）：

```json
{
  "success": true,
  "downloaded": 100,
  "total": 100,
  "failed": 0,
  "outputFile": "/abs/path/to/data/xxx.ts",
  "storage": {
    "success": true,
    "type": "local",
    "localPath": "/abs/path/to/data/xxx.ts",
    "filename": "xxx.ts"
  },
  "downloadUrl": "http://your-host/files/xxxxxx"
}
```

> `downloadUrl` 是服务为本地文件生成的一次性下载链接（内部通过 `/files/:id` 实现）。

---

### 4. 一键流程：解析 + 下载 + 存储

- **URL**：`POST /api/process`
- **认证**：需要
- **请求体**：

```json
{
  "url": "https://hsex.men/...",
  "outputDir": "data",      // 可选
  "storage": {              // 可选，存储策略
    "type": "local"
  }
}
```

处理流程：
1. 调用 `getM3U8` 解析页面，获取第一个 M3U8 URL；
2. 调用 `downloadM3U8` 下载并合并视频；
3. 调用 `handleStorage` 按配置进行存储（本地、S3、WebDAV、FTP）；
4. 若为本地存储，会生成 `downloadUrl` 供直接下载。

**成功响应示例**：

```json
{
  "success": true,
  "m3u8Url": "https://example.com/file.m3u8",
  "download": {
    "success": true,
    "downloaded": 100,
    "total": 100,
    "failed": 0,
    "outputFile": "/abs/path/to/data/xxx.ts"
  },
  "storage": {
    "success": true,
    "type": "local",
    "localPath": "/abs/path/to/data/xxx.ts",
    "filename": "xxx.ts"
  },
  "downloadUrl": "http://your-host/files/xxxxxx"
}
```

---

### 5. 本地文件下载

- **URL**：`GET /files/:id`
- **说明**：通过 ID 下载已经在服务内部注册过的本地文件。
- **用法**：无需直接手动调用，一般由 `/api/download` 或 `/api/process` 返回的 `downloadUrl` 使用。

**失败响应示例**（ID 无效或过期）：

```json
{
  "success": false,
  "error": "File not found or expired"
}
```

---

## 存储配置示例

### 1. 本地存储（默认）

```json
{
  "type": "local"
}
```

### 2. S3 / S3 兼容存储

```json
{
  "type": "s3",
  "region": "us-east-1",
  "bucket": "your-bucket",
  "key": "path/in/bucket/video.ts",
  "accessKeyId": "YOUR_ACCESS_KEY",
  "secretAccessKey": "YOUR_SECRET_KEY",
  "endpoint": "https://s3.your-provider.com",  // 可选，自定义 S3 兼容端点
  "forcePathStyle": true                        // 可选，对部分兼容服务必需
}
```

### 3. WebDAV

```json
{
  "type": "webdav",
  "url": "https://webdav.example.com",
  "username": "user",
  "password": "pass",
  "remotePath": "/path/on/server/video.ts"
}
```

### 4. FTP

```json
{
  "type": "ftp",
  "host": "ftp.example.com",
  "port": 21,
  "user": "user",
  "password": "pass",
  "secure": false,
  "remotePath": "/path/on/server/video.ts"
}
```

---

## 认证与安全

- 配置 `API_TOKEN` 后：
  - 所有 `/api/parse`、`/api/download`、`/api/process` 调用都必须携带有效 Token。
- 建议：
  - **生产环境务必配置强随机的 `API_TOKEN`**；
  - 使用 HTTPS 暴露该服务；
  - 如需外网开放，再增加额外网关 / 访问控制。

示例调用（curl）：

```bash
curl -X POST "http://localhost:3005/api/parse" ^
  -H "Content-Type: application/json" ^
  -H "x-api-token: your-secret-token" ^
  -d "{\"url\": \"https://hsex.men/...\"}"
```

---

## 日志与调试

- 全局请求日志：打印请求时间、方法、路径及请求体；
- 解析、下载、存储过程均带有详细的 `console.log` / `console.error` 日志；
- 若遇到问题，可直接查看终端输出的 **步骤日志** 与 **错误堆栈**。

---


---

## 许可证

当前使用 `ISC` 许可证（见 `package.json`）。


