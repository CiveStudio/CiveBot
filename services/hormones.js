// 🧬 激素系统：饱腹/困倦/无聊/多巴胺/血清素/皮质醇，连续变化，SQLite 持久化
module.exports = function createHormones(db) {
    const BASELINE = { dopamine: 50, serotonin: 55, cortisol: 25 };
    db.exec(`CREATE TABLE IF NOT EXISTS hormones (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        fullness REAL DEFAULT 70, sleepiness REAL DEFAULT 20, boredom REAL DEFAULT 20,
        dopamine REAL DEFAULT 50, serotonin REAL DEFAULT 55, cortisol REAL DEFAULT 25,
        updated_at INTEGER DEFAULT 0
    )`);
    db.exec(`INSERT OR IGNORE INTO hormones (id, updated_at) VALUES (1, 0)`);

    let h = null;
    const clamp = (v) => Math.max(0, Math.min(100, v));
    function load() {
        const r = db.prepare('SELECT * FROM hormones WHERE id = 1').get();
        h = { fullness: r.fullness, sleepiness: r.sleepiness, boredom: r.boredom,
              dopamine: r.dopamine, serotonin: r.serotonin, cortisol: r.cortisol };
        return h;
    }
    function save() {
        db.prepare(`UPDATE hormones SET fullness=?, sleepiness=?, boredom=?, dopamine=?, serotonin=?, cortisol=?, updated_at=? WHERE id=1`)
          .run(h.fullness, h.sleepiness, h.boredom, h.dopamine, h.serotonin, h.cortisol, Date.now());
    }

    // 每 10 分钟调用：自然漂移
    function tick() {
        if (!h) load();
        const hour = new Date().getHours();
        const night = hour >= 23 || hour < 7;
        const morning = hour >= 7 && hour < 9;
        h.fullness = clamp(h.fullness - (night ? 1.2 : 0.8));
        h.sleepiness = clamp(h.sleepiness + (night ? 2.5 : (morning ? -6 : 0.6)));
        h.boredom = clamp(h.boredom + 1.2);
        for (const k of ['dopamine', 'serotonin', 'cortisol']) {
            const t = BASELINE[k];
            h[k] = clamp(h[k] + Math.sign(t - h[k]) * (k === 'cortisol' ? 0.5 : 0.8));
        }
        save();
    }

    // 收到消息时调用：事件驱动
    function onMessage(text) {
        if (!h) load();
        const t = String(text || '');
        h.boredom = clamp(h.boredom - 18);
        if (/乖|可爱|喜欢你|好棒|厉害|想你|爱你/.test(t)) {
            h.dopamine = clamp(h.dopamine + 10); h.serotonin = clamp(h.serotonin + 6); h.boredom = clamp(h.boredom - 5);
        }
        if (/笨|蠢|滚|烦|闭嘴|讨厌|傻/.test(t)) {
            h.cortisol = clamp(h.cortisol + 15); h.serotonin = clamp(h.serotonin - 8);
        }
        if (/晚安|睡了|睡觉/.test(t)) h.sleepiness = clamp(h.sleepiness + 15);
        if (/吃|饭|奶茶|零食|饿/.test(t)) h.fullness = clamp(h.fullness + 8);
        save();
    }

    function describe() {
        if (!h) load();
        const s = [];
        if (h.fullness < 25) s.push('很饿'); else if (h.fullness < 45) s.push('有点饿');
        else if (h.fullness > 85) s.push('饱饱的');
        if (h.sleepiness > 75) s.push('很困'); else if (h.sleepiness > 50) s.push('有点困');
        else if (h.sleepiness < 15) s.push('精神');
        if (h.boredom > 75) s.push('快闲到长毛了'); else if (h.boredom > 50) s.push('有点无聊');
        if (h.dopamine > 75) s.push('兴奋'); else if (h.dopamine < 30) s.push('提不起劲');
        if (h.serotonin < 35) s.push('情绪低落'); else if (h.serotonin > 80) s.push('心里暖暖的');
        if (h.cortisol > 65) s.push('烦躁');
        return s.length ? s.join('、') : '状态平稳';
    }

    function snapshot() {
        if (!h) load();
        return `【身体状态】饱腹 ${Math.round(h.fullness)}/100，困倦 ${Math.round(h.sleepiness)}/100，无聊 ${Math.round(h.boredom)}/100，多巴胺 ${Math.round(h.dopamine)}，血清素 ${Math.round(h.serotonin)}，皮质醇 ${Math.round(h.cortisol)}。你现在的感觉：${describe()}。`;
    }

    function guidance() {
        if (!h) load();
        const g = [];
        if (h.fullness < 25) g.push('你饿得不行，说话没力气，可以顺口提想吃东西');
        if (h.sleepiness > 75) g.push('你困得睁不开眼，回复要短，可能说着说着就睡着');
        else if (h.sleepiness > 50) g.push('你有点犯困，说话懒洋洋的');
        if (h.boredom > 75) g.push('你无聊到快长毛，会更黏人，主动找话聊');
        if (h.dopamine > 75) g.push('你现在很兴奋，话多、语气雀跃');
        if (h.cortisol > 65) g.push('你现在有点烦躁，说话容易带刺，别装乖');
        if (h.serotonin < 35) g.push('你情绪低落，有点丧，不想撒娇');
        return g.length ? g.join('；') + '。' : '';
    }

    load();
    return { tick, onMessage, snapshot, guidance };
};