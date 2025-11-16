import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient as createWebDavClient } from 'webdav';
import ftp from 'basic-ftp';

/**
 * 通用上传入口
 * @param {string} localFile 本地文件绝对路径
 * @param {object} storageConfig 存储配置
 * @param {string} requestId 日志用请求 ID
 * @returns {Promise<object>} 存储结果
 */
export async function handleStorage(localFile, storageConfig = {}, requestId = '') {
    const type = storageConfig?.type || 'local';
    console.log(`[Storage] [${requestId}] 处理存储类型: ${type}`);
    console.log(`[Storage] [${requestId}] 本地文件: ${localFile}`);

    if (!localFile || !fs.existsSync(localFile)) {
        return {
            success: false,
            error: 'Local file not found',
            errmsg: `File not exists: ${localFile}`
        };
    }

    switch (type) {
        case 'local':
            // local 类型只由调用方注册成 URL，因此这里只返回基础信息
            return {
                success: true,
                type: 'local',
                localPath: localFile,
                filename: path.basename(localFile)
            };
        case 's3':
            return await uploadToS3(localFile, storageConfig, requestId);
        case 'webdav':
            return await uploadToWebDav(localFile, storageConfig, requestId);
        case 'ftp':
            return await uploadToFtp(localFile, storageConfig, requestId);
        default:
            return {
                success: false,
                error: 'Unsupported storage type',
                errmsg: `Unknown storage type: ${type}`
            };
    }
}

async function uploadToS3(localFile, cfg, requestId = '') {
    const {
        region,
        bucket,
        key,
        accessKeyId,
        secretAccessKey,
        endpoint,
        forcePathStyle
    } = cfg || {};

    if (!bucket || !key) {
        return {
            success: false,
            error: 'Invalid S3 config',
            errmsg: 'bucket and key are required for S3 storage'
        };
    }

    console.log(`[Storage:S3] [${requestId}] 准备上传到 S3: s3://${bucket}/${key}`);

    const client = new S3Client({
        region,
        endpoint,
        forcePathStyle,
        credentials: accessKeyId && secretAccessKey ? {
            accessKeyId,
            secretAccessKey
        } : undefined
    });

    try {
        const fileStream = fs.createReadStream(localFile);
        await client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: fileStream
            })
        );

        console.log(`[Storage:S3] [${requestId}] ✓ 上传成功`);

        const location = endpoint
            ? `${endpoint}/${bucket}/${key}`
            : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

        return {
            success: true,
            type: 's3',
            bucket,
            key,
            location
        };
    } catch (err) {
        console.error(`[Storage:S3] [${requestId}] ✗ 上传失败: ${err.message}`);
        console.error(`[Storage:S3] [${requestId}] 堆栈:`, err.stack);
        return {
            success: false,
            error: 'S3 upload failed',
            errmsg: err.message
        };
    }
}

async function uploadToWebDav(localFile, cfg, requestId = '') {
    const {
        url,
        username,
        password,
        remotePath
    } = cfg || {};

    if (!url || !remotePath) {
        return {
            success: false,
            error: 'Invalid WebDAV config',
            errmsg: 'url and remotePath are required for WebDAV storage'
        };
    }

    console.log(`[Storage:WebDAV] [${requestId}] 准备上传到 WebDAV: ${url}${remotePath}`);

    try {
        const client = createWebDavClient(url, {
            username,
            password
        });

        const data = fs.readFileSync(localFile);
        await client.putFileContents(remotePath, data, { overwrite: true });

        console.log(`[Storage:WebDAV] [${requestId}] ✓ 上传成功`);

        return {
            success: true,
            type: 'webdav',
            url,
            remotePath
        };
    } catch (err) {
        console.error(`[Storage:WebDAV] [${requestId}] ✗ 上传失败: ${err.message}`);
        console.error(`[Storage:WebDAV] [${requestId}] 堆栈:`, err.stack);
        return {
            success: false,
            error: 'WebDAV upload failed',
            errmsg: err.message
        };
    }
}

async function uploadToFtp(localFile, cfg, requestId = '') {
    const {
        host,
        port = 21,
        user,
        password,
        secure = false,
        remotePath
    } = cfg || {};

    if (!host || !remotePath) {
        return {
            success: false,
            error: 'Invalid FTP config',
            errmsg: 'host and remotePath are required for FTP storage'
        };
    }

    console.log(`[Storage:FTP] [${requestId}] 准备上传到 FTP: ${host}:${port} -> ${remotePath}`);

    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
        await client.access({
            host,
            port,
            user,
            password,
            secure
        });

        const remoteDir = path.dirname(remotePath);
        const remoteFile = path.basename(remotePath);

        if (remoteDir && remoteDir !== '.' && remoteDir !== '/') {
            await client.ensureDir(remoteDir);
        }

        await client.uploadFrom(localFile, remoteFile);

        console.log(`[Storage:FTP] [${requestId}] ✓ 上传成功`);

        return {
            success: true,
            type: 'ftp',
            host,
            port,
            remotePath
        };
    } catch (err) {
        console.error(`[Storage:FTP] [${requestId}] ✗ 上传失败: ${err.message}`);
        console.error(`[Storage:FTP] [${requestId}] 堆栈:`, err.stack);
        return {
            success: false,
            error: 'FTP upload failed',
            errmsg: err.message
        };
    } finally {
        client.close();
    }
}


