import puppeteer from 'puppeteer';
import cheerio from 'cheerio';

export default async function getM3U8(originUrl) {
    console.log(`[Parse] 开始解析 URL: ${originUrl}`);
    let browser = null;
    
    // 检查URL有效性
    try {
        console.log('[Parse] 步骤 1: 验证 URL 格式...');
        const url = new URL(originUrl);
        console.log(`[Parse] URL 解析成功 - Host: ${url.host}, Protocol: ${url.protocol}`);
        
        if (url.host != 'hsex.men') {
            console.error(`[Parse] 错误: 主机名不匹配 - 期望: 'hsex.men', 实际: '${url.host}'`);
            return {
                success: false,
                error: 'Invalid Host',
                errmsg: `Expected host 'hsex.men', got '${url.host}'`
            }
        }
        console.log('[Parse] ✓ URL 验证通过');
    } catch (e) {
        console.error(`[Parse] 错误: URL 格式无效 - ${e.message}`);
        console.error(`[Parse] 错误堆栈:`, e.stack);
        return {
            success: false,
            error: 'Invalid URL',
            errmsg: e.message
        }
    }

    try {
        // 使用 Puppeteer 启动浏览器
        console.log('[Parse] 步骤 2: 启动 Puppeteer 浏览器...');
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        console.log('[Parse] ✓ 浏览器启动成功');
        
        const page = await browser.newPage();
        console.log('[Parse] ✓ 新页面创建成功');
        
        // 设置超时和用户代理
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        console.log('[Parse] ✓ 用户代理设置完成');
        
        // 访问页面，设置超时时间
        console.log(`[Parse] 步骤 3: 访问页面 ${originUrl}...`);
        await page.goto(originUrl, { 
            waitUntil: 'networkidle0',
            timeout: 30000 
        });
        console.log('[Parse] ✓ 页面加载完成');
        
        console.log('[Parse] 步骤 4: 获取页面内容...');
        const content = await page.content();
        console.log(`[Parse] ✓ 页面内容获取成功，长度: ${content.length} 字符`);
        
        await browser.close();
        browser = null;
        console.log('[Parse] ✓ 浏览器已关闭');

        // 使用 Cheerio 解析
        console.log('[Parse] 步骤 5: 使用 Cheerio 解析 HTML...');
        const $ = cheerio.load(content);
        let sources = [];
        let sourceCount = 0;

        // 提取标题：优先使用 class="panel-title" 的 h3 标签，其次使用 <title>
        let titleText = '';
        try {
            const panelTitle = $('h3.panel-title').first().text().trim();
            const pageTitle = $('title').first().text().trim();

            if (panelTitle) {
                titleText = panelTitle;
                console.log(`[Parse] 提取到 panel-title 作为标题: ${titleText}`);
            } else if (pageTitle) {
                titleText = pageTitle;
                console.log(`[Parse] 提取到 <title> 作为标题: ${titleText}`);
            } else {
                console.log('[Parse] 未找到 panel-title 或 <title> 标题，使用空标题');
            }
        } catch (titleError) {
            console.error('[Parse] 提取标题时发生错误:', titleError.message);
        }
        
        $('source').each((index, element) => {
            sourceCount++;
            const type = $(element).attr('type');
            const src = $(element).attr('src');
            console.log(`[Parse] 找到 source 标签 #${sourceCount} - type: ${type || '未设置'}, src: ${src || '未设置'}`);
            
            if (type === 'application/x-mpegURL' || type === 'application/vnd.apple.mpegurl') {
                if (src) {
                    let finalSrc = src;
                    // 处理相对路径
                    if (!src.startsWith('http://') && !src.startsWith('https://')) {
                        const baseUrl = new URL(originUrl);
                        finalSrc = new URL(src, baseUrl).href;
                        console.log(`[Parse] 相对路径转换为绝对路径: ${src} -> ${finalSrc}`);
                    }
                    sources.push(finalSrc);
                    console.log(`[Parse] ✓ 添加 M3U8 URL: ${finalSrc}`);
                } else {
                    console.log(`[Parse] ⚠ source 标签缺少 src 属性`);
                }
            }
        });
        
        console.log(`[Parse] 解析完成 - 总共找到 ${sourceCount} 个 source 标签，其中 ${sources.length} 个有效的 M3U8 URL`);
        
        if (sources.length === 0) {
            console.error('[Parse] 错误: 未找到有效的 M3U8 URL');
            console.log('[Parse] 调试信息: 页面内容前 500 字符:');
            console.log(content.substring(0, 500));
        }
        
        return {
            success: sources.length > 0,
            error: sources.length > 0 ? undefined : 'No Valid M3U8 URL Found.',
            result: sources,
            title: titleText || undefined
        };
    } catch (error) {
        console.error('[Parse] 发生异常:', error.message);
        console.error('[Parse] 错误堆栈:', error.stack);
        
        // 确保浏览器被关闭
        if (browser) {
            try {
                console.log('[Parse] 尝试关闭浏览器...');
                await browser.close();
                console.log('[Parse] ✓ 浏览器已关闭');
            } catch (closeError) {
                console.error('[Parse] 错误: 关闭浏览器失败:', closeError.message);
                console.error('[Parse] 关闭浏览器错误堆栈:', closeError.stack);
            }
        }
        
        return {
            success: false,
            error: 'Failed to parse page',
            errmsg: error.message
        };
    }
}