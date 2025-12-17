// 测试日志功能
import './utils/logger.js';

console.log('这是一条测试日志信息');
console.log('这是另一条测试日志，包含对象:', { key: 'value', number: 123 });
console.error('这是一条错误日志');
console.error('这是另一条错误日志，包含错误对象:', new Error('测试错误'));

console.log('日志测试完成，请检查 logs/ 文件夹中的日志文件');