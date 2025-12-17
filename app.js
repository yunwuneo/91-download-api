import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
// 引入日志模块
import './utils/logger.js';
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

// 下载任务注册表，用于跟踪异步下载任务
const taskRegistry = new Map();

// 生成唯一的任务ID
function generateJobId() {
    return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 任务状态常量
const TASK_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

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
// 支持两种形式：
// 1) /files/:id
// 2) /files/:id/:filename   （filename 仅用于给下载工具展示，不参与实际查找）
app.get('/files/:id/:filename?', (req, res) => {
    const id = req.params.id; // 忽略 filename，只用 id 找文件
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

// 下载 M3U8 视频（异步模式）
app.post('/api/download', authMiddleware, async (req, res) => {
    const { m3u8Url, outputDir, storage } = req.body;
    
    if (!m3u8Url) {
        console.error(`[API] ✗ 错误: 缺少必需参数 'm3u8Url'`);
        return res.status(400).json({
            success: false,
            error: 'Missing required parameter: m3u8Url'
        });
    }

    // 生成任务ID
    const jobId = generateJobId();
    const requestId = Date.now();
    
    // 初始化任务状态
    const initialTaskStatus = {
        jobId,
        status: TASK_STATUS.PENDING,
        requestId,
        createdAt: new Date().toISOString(),
        m3u8Url,
        outputDir: outputDir || 'data',
        storage: storage || { type: 'local' },
        progress: 0
    };
    
    taskRegistry.set(jobId, initialTaskStatus);
    
    console.log(`[API] [${requestId}] ========== 收到下载请求 ==========`);
    console.log(`[API] [${requestId}] 生成任务ID: ${jobId}`);
    console.log(`[API] [${requestId}] 请求体:`, JSON.stringify(req.body, null, 2));
    
    // 立即返回jobid给客户端
    res.json({
        success: true,
        jobId,
        message: 'Download task has been started. Please check status with jobId.'
    });
    
    // 在后台异步处理下载任务
    (async () => {
        try {
            // 更新任务状态为处理中
            taskRegistry.set(jobId, {
                ...initialTaskStatus,
                status: TASK_STATUS.PROCESSING
            });
            
            console.log(`[API] [${requestId}] 开始调用 downloadM3U8(${m3u8Url}, ${outputDir || 'data'})...`);
            // 添加进度回调函数
            const progressCallback = (progressInfo) => {
                const currentTask = taskRegistry.get(jobId);
                if (currentTask) {
                    taskRegistry.set(jobId, {
                        ...currentTask,
                        progress: progressInfo.progress,
                        phase: progressInfo.phase,
                        downloaded: progressInfo.downloaded,
                        total: progressInfo.total,
                        failed: progressInfo.failed
                    });
                }
            };
            
            const result = await downloadM3U8(m3u8Url, outputDir, undefined, progressCallback);
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
                    const baseUrl = 
                        process.env.DOWNLOAD_BASE_URL || 
                        storageConfig.baseUrl || 
                        `http://localhost:${process.env.PORT || 3005}`;
                    downloadUrl = `${baseUrl}/files/${fileId}`;
                    console.log(`[API] [${requestId}] 生成本地下载 URL: ${downloadUrl}`);
                }
            }

            if (result.success) {
                console.log(`[API] [${requestId}] ✓ 下载成功 - 成功: ${result.downloaded}/${result.total}, 失败: ${result.failed || 0}`);
                
                // 更新任务状态为完成
                taskRegistry.set(jobId, {
                    ...initialTaskStatus,
                    status: TASK_STATUS.COMPLETED,
                    completedAt: new Date().toISOString(),
                    result: {
                        ...result,
                        storage: storageResult || undefined,
                        downloadUrl: downloadUrl || undefined
                    },
                    progress: 100
                });
            } else {
                console.error(`[API] [${requestId}] ✗ 下载失败: ${result.error} - ${result.errmsg || ''}`);
                
                // 更新任务状态为失败
                taskRegistry.set(jobId, {
                    ...initialTaskStatus,
                    status: TASK_STATUS.FAILED,
                    completedAt: new Date().toISOString(),
                    error: result.error,
                    errmsg: result.errmsg || '',
                    progress: 100
                });
            }
        } catch (error) {
            console.error(`[API] [${requestId}] ✗ 异常: ${error.message}`);
            console.error(`[API] [${requestId}] 错误堆栈:`, error.stack);
            
            // 更新任务状态为失败
            taskRegistry.set(jobId, {
                ...initialTaskStatus,
                status: TASK_STATUS.FAILED,
                completedAt: new Date().toISOString(),
                error: 'Internal server error',
                errmsg: error.message,
                progress: 100
            });
        } finally {
            console.log(`[API] [${requestId}] ========== 请求处理完成 ==========`);
        }
    })();
});

// 完整流程：解析 + 下载（异步模式）
app.post('/api/process', authMiddleware, async (req, res) => {
    const { url, outputDir, storage } = req.body;
    
    if (!url) {
        console.error(`[API] ✗ 错误: 缺少必需参数 'url'`);
        return res.status(400).json({
            success: false,
            error: 'Missing required parameter: url'
        });
    }

    // 生成任务ID
    const jobId = generateJobId();
    const requestId = Date.now();
    
    // 初始化任务状态
    const initialTaskStatus = {
        jobId,
        status: TASK_STATUS.PENDING,
        requestId,
        createdAt: new Date().toISOString(),
        url,
        outputDir: outputDir || 'data',
        storage: storage || { type: 'local' },
        progress: 0,
        phase: 'pending'
    };
    
    taskRegistry.set(jobId, initialTaskStatus);
    
    console.log(`[API] [${requestId}] ========== 收到完整流程请求 ==========`);
    console.log(`[API] [${requestId}] 生成任务ID: ${jobId}`);
    console.log(`[API] [${requestId}] 请求体:`, JSON.stringify(req.body, null, 2));
    
    // 立即返回jobid给客户端
    res.json({
        success: true,
        jobId,
        message: 'Process task has been started. Please check status with jobId.'
    });
    
    // 在后台异步处理完整流程
    (async () => {
        try {
            // 更新任务状态为处理中
            taskRegistry.set(jobId, {
                ...initialTaskStatus,
                status: TASK_STATUS.PROCESSING,
                phase: 'parsing'
            });
            
            // 第一步：解析页面获取 M3U8 URL
            console.log(`[API] [${requestId}] ========== 步骤 1: 解析页面 ==========`);
            console.log(`[API] [${requestId}] 开始解析 URL: ${url}`);
            const parseResult = await getM3U8(url);
            console.log(`[API] [${requestId}] 解析结果:`, JSON.stringify(parseResult, null, 2));
            
            if (!parseResult.success || !parseResult.result || parseResult.result.length === 0) {
                console.error(`[API] [${requestId}] ✗ 解析失败: ${parseResult.error} - ${parseResult.errmsg || ''}`);
                
                // 更新任务状态为失败
                taskRegistry.set(jobId, {
                    ...initialTaskStatus,
                    status: TASK_STATUS.FAILED,
                    completedAt: new Date().toISOString(),
                    error: 'Failed to parse M3U8 URL from page',
                    parseError: parseResult.error,
                    parseErrmsg: parseResult.errmsg,
                    progress: 33 // 解析阶段大约占总进度的33%
                });
                return;
            }

            // 使用第一个找到的 M3U8 URL
            const m3u8Url = parseResult.result[0];
            console.log(`[API] [${requestId}] ✓ 解析成功，找到 ${parseResult.result.length} 个 M3U8 URL`);
            console.log(`[API] [${requestId}] 使用第一个 M3U8 URL: ${m3u8Url}`);
            
            // 更新任务进度
            taskRegistry.set(jobId, {
                ...initialTaskStatus,
                status: TASK_STATUS.PROCESSING,
                phase: 'downloading',
                m3u8Url,
                progress: 33 // 解析完成，进度到33%
            });
            
            // 第二步：下载视频
            console.log(`[API] [${requestId}] ========== 步骤 2: 下载视频 ==========`);
            console.log(`[API] [${requestId}] 开始下载 M3U8: ${m3u8Url}`);
            const videoTitle = parseResult.title || 'merged_video.ts';
            console.log(`[API] [${requestId}] 使用标题作为文件名: ${videoTitle}`);
            
            // 添加进度回调函数
            const progressCallback = (progressInfo) => {
                const currentTask = taskRegistry.get(jobId);
                if (currentTask) {
                    // 计算总进度（解析占33%，下载占67%）
                    const overallProgress = 33 + Math.floor((progressInfo.progress / 100) * 67);
                    
                    taskRegistry.set(jobId, {
                        ...currentTask,
                        progress: overallProgress,
                        phase: `downloading-${progressInfo.phase}`,
                        downloaded: progressInfo.downloaded,
                        total: progressInfo.total,
                        failed: progressInfo.failed
                    });
                }
            };
            
            const downloadResult = await downloadM3U8(m3u8Url, outputDir, videoTitle, progressCallback);
            console.log(`[API] [${requestId}] 下载结果:`, JSON.stringify(downloadResult, null, 2));

            // 更新任务进度
            taskRegistry.set(jobId, {
                ...initialTaskStatus,
                status: TASK_STATUS.PROCESSING,
                phase: 'storing',
                m3u8Url,
                progress: 66 // 下载完成，进度到66%
            });

            // 存储后处理
            let storageResult = null;
            let downloadUrl = null;

            if (downloadResult.success && downloadResult.outputFile) {
                const storageConfig = storage || { type: 'local' };
                console.log(`[API] [${requestId}] 开始存储后处理, type=${storageConfig.type || 'local'}`);

                storageResult = await handleStorage(downloadResult.outputFile, storageConfig, requestId);

                if (storageResult?.type === 'local' && storageResult.success) {
                    const fileId = registerFile(downloadResult.outputFile);
                    const baseUrl = 
                        process.env.DOWNLOAD_BASE_URL || 
                        storageConfig.baseUrl || 
                        `http://localhost:${process.env.PORT || 3005}`;
                    downloadUrl = `${baseUrl}/files/${fileId}`;
                    console.log(`[API] [${requestId}] 生成本地下载 URL: ${downloadUrl}`);
                }
            }
        
            if (downloadResult.success) {
                console.log(`[API] [${requestId}] ✓ 完整流程成功完成`);
                
                // 更新任务状态为完成
                taskRegistry.set(jobId, {
                    ...initialTaskStatus,
                    status: TASK_STATUS.COMPLETED,
                    completedAt: new Date().toISOString(),
                    phase: 'completed',
                    m3u8Url,
                    result: {
                        m3u8Url: m3u8Url,
                        download: downloadResult,
                        storage: storageResult || undefined,
                        downloadUrl: downloadUrl || undefined
                    },
                    progress: 100
                });
            } else {
                console.error(`[API] [${requestId}] ✗ 下载失败: ${downloadResult.error} - ${downloadResult.errmsg || ''}`);
                
                // 更新任务状态为失败
                taskRegistry.set(jobId, {
                    ...initialTaskStatus,
                    status: TASK_STATUS.FAILED,
                    completedAt: new Date().toISOString(),
                    phase: 'failed',
                    m3u8Url,
                    error: 'Download failed',
                    downloadError: downloadResult.error,
                    downloadErrmsg: downloadResult.errmsg,
                    downloadDetails: downloadResult,
                    progress: 66
                });
            }
        } catch (error) {
            console.error(`[API] [${requestId}] ✗ 异常: ${error.message}`);
            console.error(`[API] [${requestId}] 错误堆栈:`, error.stack);
            
            // 更新任务状态为失败
            taskRegistry.set(jobId, {
                ...initialTaskStatus,
                status: TASK_STATUS.FAILED,
                completedAt: new Date().toISOString(),
                phase: 'failed',
                error: 'Internal server error',
                errmsg: error.message,
                progress: 0
            });
        } finally {
            console.log(`[API] [${requestId}] ========== 请求处理完成 ==========`);
        }
    })();
});

// 查询任务状态接口
app.get('/api/status/:jobid', authMiddleware, (req, res) => {
    const jobId = req.params.jobid;
    const task = taskRegistry.get(jobId);
    
    if (!task) {
        return res.status(404).json({
            success: false,
            error: 'Task not found',
            message: 'The specified jobId does not exist or has been expired.'
        });
    }
    
    // 构建响应对象
    const response = {
        success: true,
        jobId: task.jobId,
        status: task.status,
        progress: task.progress,
        phase: task.phase,
        createdAt: task.createdAt,
        requestId: task.requestId,
        m3u8Url: task.m3u8Url,
        outputDir: task.outputDir,
        storage: task.storage
    };
    
    // 添加其他可选字段
    if (task.downloaded !== undefined) response.downloaded = task.downloaded;
    if (task.total !== undefined) response.total = task.total;
    if (task.failed !== undefined) response.failed = task.failed;
    if (task.completedAt !== undefined) response.completedAt = task.completedAt;
    if (task.url !== undefined) response.url = task.url;
    
    // 仅当任务完成时，将downloadUrl提升到最外层
    if (task.status === TASK_STATUS.COMPLETED && task.result?.downloadUrl) {
        response.downloadUrl = task.result.downloadUrl;
    }
    
    // 仅在任务失败时返回错误信息
    if (task.status === TASK_STATUS.FAILED) {
        if (task.error) response.error = task.error;
        if (task.errmsg) response.errmsg = task.errmsg;
        if (task.parseError) response.parseError = task.parseError;
        if (task.parseErrmsg) response.parseErrmsg = task.parseErrmsg;
        if (task.downloadError) response.downloadError = task.downloadError;
        if (task.downloadErrmsg) response.downloadErrmsg = task.downloadErrmsg;
        if (task.downloadDetails) response.downloadDetails = task.downloadDetails;
    }
    
    // 返回任务状态
    res.json(response);
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