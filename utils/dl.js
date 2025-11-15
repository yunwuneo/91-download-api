import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function downloadM3U8(m3u8URL, outputDir = 'data') {
    console.log(`[Download] 开始下载 M3U8: ${m3u8URL}`);
    console.log(`[Download] 输出目录: ${outputDir}`);
    
    // 检查 URL 有效性
    try {
        console.log('[Download] 步骤 1: 验证 M3U8 URL 格式...');
        const url = new URL(m3u8URL);
        console.log(`[Download] ✓ URL 验证通过 - ${url.href}`);
    } catch (err) {
        console.error(`[Download] 错误: M3U8 URL 格式无效 - ${err.message}`);
        console.error(`[Download] 错误堆栈:`, err.stack);
        return {
            success: false,
            error: 'Received Invalid m3u8 URL.',
            errmsg: err.message
        }
    }

    // 获取 m3u8 内容
    console.log('[Download] 步骤 2: 获取 M3U8 文件内容...');
    let m3u8Content;
    try {
        const reqM3U8 = await fetch(m3u8URL);
        console.log(`[Download] HTTP 响应状态: ${reqM3U8.status} ${reqM3U8.statusText}`);
        
        if (reqM3U8.status != 200) {
            console.error(`[Download] 错误: HTTP 状态码非 200 - ${reqM3U8.status}`);
            return {
                success: false,
                error: 'Non-200 Http Code Received while Getting m3u8 File.',
                errmsg: `HTTP Code ${reqM3U8.status}`
            }
        }
        
        m3u8Content = await reqM3U8.text();
        console.log(`[Download] ✓ M3U8 内容获取成功，长度: ${m3u8Content.length} 字符`);
        console.log(`[Download] M3U8 内容前 200 字符: ${m3u8Content.substring(0, 200)}`);
    } catch (fetchError) {
        console.error(`[Download] 错误: 获取 M3U8 文件失败 - ${fetchError.message}`);
        console.error(`[Download] 错误堆栈:`, fetchError.stack);
        return {
            success: false,
            error: 'Failed to fetch M3U8 file',
            errmsg: fetchError.message
        }
    }
    
    // 验证是否是有效的 M3U8 文件内容
    console.log('[Download] 步骤 3: 验证 M3U8 文件格式...');
    if (!m3u8Content.includes('#EXTM3U')) {
        console.error('[Download] 错误: M3U8 文件缺少 #EXTM3U 头');
        console.log(`[Download] 文件内容前 500 字符: ${m3u8Content.substring(0, 500)}`);
        return {
            success: false,
            error: 'Invalid M3U8 file content. Missing #EXTM3U header.'
        }
    }
    console.log('[Download] ✓ M3U8 文件格式验证通过');

    // 创建输出目录
    console.log('[Download] 步骤 4: 创建输出目录...');
    const outputPath = path.join(__dirname, '..', outputDir);
    console.log(`[Download] 输出路径: ${outputPath}`);
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
        console.log(`[Download] ✓ 输出目录创建成功: ${outputPath}`);
    } else {
        console.log(`[Download] ✓ 输出目录已存在: ${outputPath}`);
    }

    // 解析 M3U8 获取 TS 片段列表
    console.log('[Download] 步骤 5: 解析 M3U8 文件，提取 TS 片段列表...');
    const tsSegments = [];
    const baseURL = new URL(m3u8URL);
    const basePath = m3u8URL.substring(0, m3u8URL.lastIndexOf('/') + 1);
    console.log(`[Download] 基础 URL: ${baseURL.href}`);
    console.log(`[Download] 基础路径: ${basePath}`);
    
    const lines = m3u8Content.split('\n');
    console.log(`[Download] M3U8 文件总行数: ${lines.length}`);
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) continue;
        
        if (trimmedLine.endsWith('.ts')) {
            let tsURL;
            if (trimmedLine.startsWith('http://') || trimmedLine.startsWith('https://')) {
                tsURL = trimmedLine;
                console.log(`[Download] 找到绝对路径 TS: ${tsURL}`);
            } else {
                tsURL = new URL(trimmedLine, baseURL).href;
                console.log(`[Download] 找到相对路径 TS: ${trimmedLine} -> ${tsURL}`);
            }
            tsSegments.push(tsURL);
        }
    }

    console.log(`[Download] ✓ 解析完成，找到 ${tsSegments.length} 个 TS 片段`);
    
    if (tsSegments.length === 0) {
        console.error('[Download] 错误: M3U8 文件中未找到 TS 片段');
        console.log(`[Download] M3U8 内容: ${m3u8Content.substring(0, 1000)}`);
        return {
            success: false,
            error: 'No TS segments found in M3U8 file.'
        }
    }

    // 下载所有 TS 片段
    console.log(`[Download] 步骤 6: 开始下载 ${tsSegments.length} 个 TS 片段...`);
    const downloadedFiles = [];
    const failedDownloads = [];
    
    for (let i = 0; i < tsSegments.length; i++) {
        const tsURL = tsSegments[i];
        const filename = `segment_${String(i).padStart(6, '0')}.ts`;
        const filePath = path.join(outputPath, filename);
        
        try {
            console.log(`[Download] [${i + 1}/${tsSegments.length}] 开始下载: ${filename}`);
            console.log(`[Download] [${i + 1}/${tsSegments.length}] URL: ${tsURL}`);
            
            const response = await fetch(tsURL);
            console.log(`[Download] [${i + 1}/${tsSegments.length}] HTTP 响应: ${response.status} ${response.statusText}`);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const buffer = await response.arrayBuffer();
            const bufferSize = buffer.byteLength;
            console.log(`[Download] [${i + 1}/${tsSegments.length}] 数据大小: ${(bufferSize / 1024).toFixed(2)} KB`);
            
            fs.writeFileSync(filePath, Buffer.from(buffer));
            downloadedFiles.push(filePath);
            console.log(`[Download] [${i + 1}/${tsSegments.length}] ✓ 下载成功: ${filePath}`);
        } catch (error) {
            console.error(`[Download] [${i + 1}/${tsSegments.length}] ✗ 下载失败: ${error.message}`);
            console.error(`[Download] [${i + 1}/${tsSegments.length}] 错误堆栈:`, error.stack);
            failedDownloads.push({ index: i, url: tsURL, error: error.message });
        }
    }

    console.log(`[Download] 下载完成 - 成功: ${downloadedFiles.length}/${tsSegments.length}, 失败: ${failedDownloads.length}`);
    
    if (failedDownloads.length > 0) {
        console.error(`[Download] 失败的下载详情:`);
        failedDownloads.forEach((fail, idx) => {
            console.error(`[Download]   失败 #${idx + 1}: 索引 ${fail.index}, URL: ${fail.url}, 错误: ${fail.error}`);
        });
    }

    // 合并所有 TS 片段
    if (downloadedFiles.length > 0) {
        console.log(`[Download] 步骤 7: 合并 ${downloadedFiles.length} 个 TS 片段...`);
        const outputFile = path.join(outputPath, 'merged_video.ts');
        console.log(`[Download] 输出文件: ${outputFile}`);
        
        const writeStream = fs.createWriteStream(outputFile);
        let totalSize = 0;
        
        for (let i = 0; i < downloadedFiles.length; i++) {
            const filePath = downloadedFiles[i];
            const data = fs.readFileSync(filePath);
            const fileSize = data.length;
            totalSize += fileSize;
            writeStream.write(data);
            console.log(`[Download] [合并 ${i + 1}/${downloadedFiles.length}] 已写入: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
        }
        
        writeStream.end();
        console.log(`[Download] ✓ 合并完成，总大小: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
        
        return new Promise((resolve) => {
            writeStream.on('finish', () => {
                console.log(`[Download] 步骤 8: 清理临时文件...`);
                let deletedCount = 0;
                
                // 清理临时片段文件
                for (const filePath of downloadedFiles) {
                    try {
                        fs.unlinkSync(filePath);
                        deletedCount++;
                    } catch (err) {
                        console.error(`[Download] ⚠ 删除临时文件失败: ${filePath} - ${err.message}`);
                    }
                }
                
                console.log(`[Download] ✓ 清理完成，删除了 ${deletedCount}/${downloadedFiles.length} 个临时文件`);
                console.log(`[Download] ✓ 最终输出文件: ${outputFile}`);
                
                resolve({
                    success: true,
                    downloaded: downloadedFiles.length,
                    total: tsSegments.length,
                    failed: failedDownloads.length,
                    outputFile: outputFile,
                    failedDownloads: failedDownloads.length > 0 ? failedDownloads : undefined
                });
            });
            
            writeStream.on('error', (err) => {
                console.error(`[Download] ✗ 写入文件时发生错误: ${err.message}`);
                console.error(`[Download] 错误堆栈:`, err.stack);
            });
        });
    } else {
        console.error(`[Download] ✗ 所有下载都失败了`);
        return {
            success: false,
            error: 'All downloads failed.',
            failedDownloads: failedDownloads
        }
    }
}