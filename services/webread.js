// 🌐 全网网页解析（带智能降级），B站解析转发给 bili 模块
module.exports = function createWebread({ bili }) {
    // 🎬 B站视频完全体解析器（实现在 bili.js 里，这里保留原函数名）
    async function parseBilibiliLink(text) {
        return bili.parseLink(text);
    }

    // 🌐 全网网页解析器（带智能降级）
    async function parseGeneralLink(url) {
        try {
            console.log(`🌐 检测到普通网页链接，正在抓取正文: ${url}`);
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            const html = await res.text();

            let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                           .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                           .replace(/<[^>]+>/g, ' ')
                           .replace(/\s+/g, ' ')
                           .trim();

            if (text.length > 2500) text = text.substring(0, 2500) + '... (内容过长已截断)';
            return `【全网链接阅读情报】：\n${text}`;
        } catch(e) {
            console.log('⚠️ 网页抓取失败(可能被墙)，将降级到云端搜索:', e.message);
            return `【全网链接阅读情报】：\n(本地抓取该网页失败，请直接使用 [SEARCH:${url}] 去获取该网页的信息)`;
        }
    }

    return { parseBilibiliLink, parseGeneralLink };
};