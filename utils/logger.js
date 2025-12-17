import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDir = path.join(__dirname, '..', 'logs');

// 先保存原始的console方法
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// 确保logs目录存在
originalConsoleLog(`[Logger] 尝试创建日志目录: ${logsDir}`);
try {
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
        originalConsoleLog(`[Logger] 日志目录创建成功: ${logsDir}`);
    } else {
        originalConsoleLog(`[Logger] 日志目录已存在: ${logsDir}`);
    }
} catch (err) {
    originalConsoleError(`[Logger] 创建日志目录失败: ${err.message}`);
    originalConsoleError(`[Logger] 错误堆栈:`, err.stack);
}

// 获取当前日期的日志文件名
function getLogFileName() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}.log`;
}

// 写入日志到文件
function writeLogToFile(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logLine = `${timestamp} [${level}] ${message}\n`;
    const logFilePath = path.join(logsDir, getLogFileName());
    
    fs.appendFile(logFilePath, logLine, (err) => {
        if (err) {
            originalConsoleError(`[Logger] 写入日志文件失败: ${err.message}`);
        }
    });
}

// 重写console.log方法
console.log = function(...args) {
    // 调用原始方法输出到控制台
    originalConsoleLog.apply(console, args);
    
    // 将日志保存到文件
    const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    writeLogToFile(message, 'INFO');
};

// 重写console.error方法
console.error = function(...args) {
    // 调用原始方法输出到控制台
    originalConsoleError.apply(console, args);
    
    // 将日志保存到文件
    const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    writeLogToFile(message, 'ERROR');
};

export default {
    getLogFileName,
    writeLogToFile
};