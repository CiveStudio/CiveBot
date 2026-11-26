// 🔌 插件加载器：扫描扩展仓库的 tools/ 目录，自动注册
const fs = require('fs');
const path = require('path');

module.exports = function loadPlugins(dir) {
    const plugins = [];
    if (!dir || !fs.existsSync(dir)) {
        console.log(`🔌 插件目录不存在，跳过：${dir}`);
        return plugins;
    }
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        try {
            const p = require(path.join(dir, f));
            if (p && typeof p.match === 'function' && typeof p.handle === 'function') {
                plugins.push(p);
                console.log(`🔌 已加载插件：${p.name || f}`);
            }
        } catch (e) {
            console.log(`⚠️ 插件加载失败 ${f}:`, e.message);
        }
    }
    return plugins;
};