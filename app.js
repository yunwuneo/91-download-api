import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import getM3U8 from './utils/parse.js';
import downloadM3U8 from './utils/dl.js';
import { handleStorage } from './utils/storage.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// 简单的文件注册表，用于生成一次性下载 URL
const fileRegistry = new Map();

function registerFile(filePath) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fileRegistry.set(id, filePath);
    return id;
}

// 请求日志中间件
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    if (Object.keys(req.body || {}).length > 0) {
        console.log(`[Request Body]`, JSON.stringify(req.body, null, 2));
    }
    next();
});

// 简单 token 认证中间件
// 环境变量：API_TOKEN（在 .env 中配置）
function authMiddleware(req, res, next) {
    const requiredToken = process.env.API_TOKEN;

    // 如果未配置 API_TOKEN，则不启用认证（方便本地开发）
    if (!requiredToken) {
        console.warn('[Auth] 未配置 API_TOKEN，跳过认证（仅建议在开发环境使用）');
        return next();
    }

    const headerToken = req.headers['x-api-token'] || req.headers['authorization'];
    let token = '';

    if (typeof headerToken === 'string') {
        if (headerToken.toLowerCase().startsWith('bearer ')) {
            token = headerToken.slice(7).trim();
        } else {
            token = headerToken.trim();
        }
    }

    if (!token || token !== requiredToken) {
        console.warn('[Auth] 认证失败，拒绝访问');
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            errmsg: 'Invalid or missing API token'
        });
    }

    next();
}

// CORS 中间件
app.all('*', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// 健康检查接口
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Service is running' });
});

// 通过 ID 下载已注册的本地文件
app.get('/files/:id', (req, res) => {
    const id = req.params.id;
    const filePath = fileRegistry.get(id);

    if (!filePath) {
        return res.status(404).json({
            success: false,
            error: 'File not found or expired'
        });
    }

    res.download(filePath, path.basename(filePath), (err) => {
        if (err) {
            console.error(`[Files] 下载文件失败: ${err.message}`);
        }
    });
});

// 解析页面获取 M3U8 URL
app.post('/api/parse', authMiddleware, async (req, res) => {
    const requestId = Date.now();
    console.log(`[API] [${requestId}] ========== 收到解析请求 ==========`);
    console.log(`[API] [${requestId}] 请求体:`, JSON.stringify(req.body, null, 2));
    
    try {
        const { url } = req.body;
        
        if (!url) {
            console.error(`[API] [${requestId}] ✗ 错误: 缺少必需参数 'url'`);
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: url'
            });
        }

        console.log(`[API] [${requestId}] 开始调用 getM3U8(${url})...`);
        const result = await getM3U8(url);
        console.log(`[API] [${requestId}] getM3U8 返回结果:`, JSON.stringify(result, null, 2));
        
        if (result.success) {
            console.log(`[API] [${requestId}] ✓ 解析成功，返回 ${result.result?.length || 0} 个 M3U8 URL`);
            res.json(result);
        } else {
            console.error(`[API] [${requestId}] ✗ 解析失败: ${result.error} - ${result.errmsg || ''}`);
            res.status(400).json(result);
        }
    } catch (error) {
        console.error(`[API] [${requestId}] ✗ 异常: ${error.message}`);
        console.error(`[API] [${requestId}] 错误堆栈:`, error.stack);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            errmsg: error.message
        });
    } finally {
        console.log(`[API] [${requestId}] ========== 请求处理完成 ==========`);
    }
});

// 下载 M3U8 视频
app.post('/api/download', authMiddleware, async (req, res) => {
    const requestId = Date.now();
    console.log(`[API] [${requestId}] ========== 收到下载请求 ==========`);
    console.log(`[API] [${requestId}] 请求体:`, JSON.stringify(req.body, null, 2));
    
    try {
        const { m3u8Url, outputDir, storage } = req.body;
        
        if (!m3u8Url) {
            console.error(`[API] [${requestId}] ✗ 错误: 缺少必需参数 'm3u8Url'`);
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: m3u8Url'
            });
        }

        console.log(`[API] [${requestId}] 开始调用 downloadM3U8(${m3u8Url}, ${outputDir || 'data'})...`);
        const result = await downloadM3U8(m3u8Url, outputDir);
        console.log(`[API] [${requestId}] downloadM3U8 返回结果:`, JSON.stringify(result, null, 2));

        // 根据 storage 配置进行后处理
        let storageResult = null;
        let downloadUrl = null;

        if (result.success && result.outputFile) {
            const storageConfig = storage || { type: 'local' };
            console.log(`[API] [${requestId}] 开始存储后处理, type=${storageConfig.type || 'local'}`);

            storageResult = await handleStorage(result.outputFile, storageConfig, requestId);

            if (storageResult?.type === 'local' && storageResult.success) {
                const fileId = registerFile(result.outputFile);
                const baseUrl = storageConfig.baseUrl || `${req.protocol}://${req.get('host')}`;
                downloadUrl = `${baseUrl}/files/${fileId}`;
                console.log(`[API] [${requestId}] 生成本地下载 URL: ${downloadUrl}`);
            }
        }

        if (result.success) {
            console.log(`[API] [${requestId}] ✓ 下载成功 - 成功: ${result.downloaded}/${result.total}, 失败: ${result.failed || 0}`);
            res.json({
                ...result,
                storage: storageResult || undefined,
                downloadUrl: downloadUrl || undefined
            });
        } else {
            console.error(`[API] [${requestId}] ✗ 下载失败: ${result.error} - ${result.errmsg || ''}`);
            res.status(400).json(result);
        }
    } catch (error) {
        console.error(`[API] [${requestId}] ✗ 异常: ${error.message}`);
        console.error(`[API] [${requestId}] 错误堆栈:`, error.stack);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            errmsg: error.message
        });
    } finally {
        console.log(`[API] [${requestId}] ========== 请求处理完成 ==========`);
    }
});

// 完整流程：解析 + 下载
app.post('/api/process', authMiddleware, async (req, res) => {
    const requestId = Date.now();
    console.log(`[API] [${requestId}] ========== 收到完整流程请求 ==========`);
    console.log(`[API] [${requestId}] 请求体:`, JSON.stringify(req.body, null, 2));
    
    try {
        const { url, outputDir, storage } = req.body;
        
        if (!url) {
            console.error(`[API] [${requestId}] ✗ 错误: 缺少必需参数 'url'`);
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: url'
            });
        }

        // 第一步：解析页面获取 M3U8 URL
        console.log(`[API] [${requestId}] ========== 步骤 1: 解析页面 ==========`);
        console.log(`[API] [${requestId}] 开始解析 URL: ${url}`);
        const parseResult = await getM3U8(url);
        console.log(`[API] [${requestId}] 解析结果:`, JSON.stringify(parseResult, null, 2));
        
        if (!parseResult.success || !parseResult.result || parseResult.result.length === 0) {
            console.error(`[API] [${requestId}] ✗ 解析失败: ${parseResult.error} - ${parseResult.errmsg || ''}`);
            return res.status(400).json({
                success: false,
                error: 'Failed to parse M3U8 URL from page',
                parseError: parseResult.error,
                parseErrmsg: parseResult.errmsg
            });
        }

        // 使用第一个找到的 M3U8 URL
        const m3u8Url = parseResult.result[0];
        console.log(`[API] [${requestId}] ✓ 解析成功，找到 ${parseResult.result.length} 个 M3U8 URL`);
        console.log(`[API] [${requestId}] 使用第一个 M3U8 URL: ${m3u8Url}`);
        
        // 第二步：下载视频
        console.log(`[API] [${requestId}] ========== 步骤 2: 下载视频 ==========`);
        console.log(`[API] [${requestId}] 开始下载 M3U8: ${m3u8Url}`);
        const videoTitle = parseResult.title || 'merged_video.ts';
        console.log(`[API] [${requestId}] 使用标题作为文件名: ${videoTitle}`);
        const downloadResult = await downloadM3U8(m3u8Url, outputDir, videoTitle);
        console.log(`[API] [${requestId}] 下载结果:`, JSON.stringify(downloadResult, null, 2));

        // 存储后处理
        let storageResult = null;
        let downloadUrl = null;

        if (downloadResult.success && downloadResult.outputFile) {
            const storageConfig = storage || { type: 'local' };
            console.log(`[API] [${requestId}] 开始存储后处理, type=${storageConfig.type || 'local'}`);

            storageResult = await handleStorage(downloadResult.outputFile, storageConfig, requestId);

            if (storageResult?.type === 'local' && storageResult.success) {
                const fileId = registerFile(downloadResult.outputFile);
                const baseUrl = storageConfig.baseUrl || `${req.protocol}://${req.get('host')}`;
                downloadUrl = `${baseUrl}/files/${fileId}`;
                console.log(`[API] [${requestId}] 生成本地下载 URL: ${downloadUrl}`);
            }
        }
        
        if (downloadResult.success) {
            console.log(`[API] [${requestId}] ✓ 完整流程成功完成`);
            res.json({
                success: true,
                m3u8Url: m3u8Url,
                download: downloadResult,
                storage: storageResult || undefined,
                downloadUrl: downloadUrl || undefined
            });
        } else {
            console.error(`[API] [${requestId}] ✗ 下载失败: ${downloadResult.error} - ${downloadResult.errmsg || ''}`);
            res.status(400).json({
                success: false,
                m3u8Url: m3u8Url,
                error: 'Download failed',
                downloadError: downloadResult.error,
                downloadErrmsg: downloadResult.errmsg,
                downloadDetails: downloadResult
            });
        }
    } catch (error) {
        console.error(`[API] [${requestId}] ✗ 异常: ${error.message}`);
        console.error(`[API] [${requestId}] 错误堆栈:`, error.stack);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            errmsg: error.message
        });
    } finally {
        console.log(`[API] [${requestId}] ========== 请求处理完成 ==========`);
    }
});

// 404 处理
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found'
    });
});

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error('[Error] Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        errmsg: err.message
    });
});

app.listen(process.env.PORT || 3005, () => {
    console.log(`========================================`);
    console.log(`🚀 服务器启动成功`);
    console.log(`📡 监听端口: ${process.env.PORT || 3005}`);
    console.log(`🌐 健康检查: http://localhost:${process.env.PORT || 3005}/health`);
    console.log(`========================================`);
})