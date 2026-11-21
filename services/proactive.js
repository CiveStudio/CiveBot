// 🫀 主动说话引擎：心跳、夜间静默、冷落降频、防复读、B站安利
// 通过工厂注入依赖，与 qq-bot.js 解耦
const PROACTIVE = require('../config/proactive');
const { todayStr, hhmm, rand, toMin, clampLine } = require('../utils');

module.exports = function createProactive({ db, bili, callV1, persona, laws, chatHistory, getWs }) {
    let proactiveTimer = null;
    let lastHumanAt = 0;
    const recentProactive = [];   // 最近说过的话，用来防复读

    function isQuiet(now) {
        const m = now.getHours() * 60 + now.getMinutes();
        const s = toMin(PROACTIVE.nightStart);
        const e = toMin(PROACTIVE.nightEnd);
        return s > e ? (m >= s || m < e) : (m >= s && m < e);
    }

    function atMorning(now) {
        const d = new Date(now.getTime());
        d.setHours(8, rand(0, 20), 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
        return d;
    }

    function getState() {
        let row = db.prepare('SELECT * FROM proactive WHERE id = 1').get();
        if (!row) {
            db.prepare('INSERT INTO proactive (id, next_at) VALUES (1, 0)').run();
            row = db.prepare('SELECT * FROM proactive WHERE id = 1').get();
        }
        return row;
    }

    function scheduleNext(delayMs) {
        if (proactiveTimer) clearTimeout(proactiveTimer);
        const delay = Math.max(30000, Math.floor(delayMs));
        try {
            db.prepare('UPDATE proactive SET next_at = ? WHERE id = 1').run(Date.now() + delay);
        } catch (e) { /* 忽略 */ }
        proactiveTimer = setTimeout(tick, delay);
    }

    function startProactive() {
        if (!PROACTIVE.enabled) return;
        const st = getState();
        const now = Date.now();
        if (st.next_at && st.next_at > now && st.next_at - now < 6 * 3600 * 1000) {
            const left = st.next_at - now;
            console.log(`⏰ 主动说话：恢复上次计时，${Math.round(left / 60000)} 分钟后开口`);
            scheduleNext(left);
        } else {
            scheduleNext(rand(1, 5) * 60000);
            console.log('⏰ 主动说话已启动，1–5 分钟后第一次开口');
        }
    }

    // 🌟 有人说话时调用：重置"被冷落"计数，10 分钟内不主动插嘴
    function noteHumanActivity() {
        lastHumanAt = Date.now();
        try { db.prepare('UPDATE proactive SET streak = 0 WHERE id = 1').run(); } catch (e) {}
    }

    function groupCount(id) {
        const key = 'group_' + id;
        const row = db.prepare('SELECT day, count FROM proactive_group WHERE target = ?').get(key);
        if (!row) return 0;
        return row.day === todayStr() ? row.count : 0;
    }

    function bumpGroup(id) {
        const key = 'group_' + id;
        const today = todayStr();
        const row = db.prepare('SELECT day, count FROM proactive_group WHERE target = ?').get(key);
        if (!row) db.prepare('INSERT INTO proactive_group (target, day, count) VALUES (?, ?, 1)').run(key, today);
        else if (row.day !== today) db.prepare('UPDATE proactive_group SET day = ?, count = 1 WHERE target = ?').run(today, key);
        else db.prepare('UPDATE proactive_group SET count = count + 1 WHERE target = ?').run(key);
    }

    function biliShareCount() {
        const r = db.prepare('SELECT day, count FROM bili_share WHERE day = ?').get(todayStr());
        return r ? r.count : 0;
    }

    function bumpBiliShare() {
        const t = todayStr();
        const r = db.prepare('SELECT count FROM bili_share WHERE day = ?').get(t);
        if (!r) db.prepare('INSERT INTO bili_share (day, count) VALUES (?, 1)').run(t);
        else db.prepare('UPDATE bili_share SET count = count + 1 WHERE day = ?').run(t);
    }

    function pickTarget() {
        const groups = (PROACTIVE.groups || []).filter((g) => g && g.id);
        if (groups.length && Math.random() < PROACTIVE.groupChance) {
            const g = groups[rand(0, groups.length - 1)];
            if (groupCount(g.id) < (g.dailyCap || PROACTIVE.groupDailyCap)) {
                return { type: 'group', id: g.id, name: g.name };
            }
        }
        return { type: 'private', id: PROACTIVE.privateQQ };
    }

    async function buildClues(target) {
        const now = new Date();
        const h = now.getHours();
        const period = h < 5 ? '凌晨' : h < 8 ? '清早' : h < 11 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
        const chatId = target.type === 'group' ? `group_${target.id}` : `private_${target.id}`;
        const hist = chatHistory.get(chatId) || [];
        const lastUser = [...hist].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');

        const parts = [`现在是${period}（${hhmm(now)}），没有人跟你说话。`];
        if (lastUser && lastUser.content) parts.push(`你们上次聊到：${String(lastUser.content).slice(0, 40)}。`);

        // 偶尔让她"刷"到一个 B 站视频，作为话头（带链接，告别"链接没存住"）
        let video = null;
        if (Math.random() < 0.2) {
            try {
                const v = await bili.pickFeed();
                if (v) {
                    video = v;
                    parts.push(`你刚刷到B站一个视频《${v.title}》（${v.owner || '未知UP'}），简介：${String(v.desc || '').slice(0, 60)}。视频链接：${v.link}。想聊它就把链接贴在句尾。`);
                }
            } catch (e) { /* 刷不到就算了 */ }
        }

        parts.push('你可以问他在干嘛、吐槽、自言自语、或者分享刚看到的东西。');
        return { text: parts.join(''), video };
    }

    function appendVideoLink(line, video, isGroup) {
        // 私聊才自动拼链接；她自己带了就不重复
        if (!video || !video.link || isGroup) return line;
        if (line.includes('b23.tv') || (video.bvid && line.includes(video.bvid))) return line;
        const t = video.title || '';
        const mentioned = ['视频', '刷到', '链接', '快看', '看看'].some((k) => line.includes(k)) || (t.length >= 6 && line.includes(t.slice(0, 6)));
        return mentioned ? line + ' ' + video.link : line;
    }

    async function think(target) {
        const isGroup = target.type === 'group';
        const senderName = isGroup ? (target.name || '群友') : 'LouFung';
        const systemPrompt = persona.buildSystemPrompt(isGroup, senderName);
        const clues = await buildClues(target);
        const maxLen = isGroup ? PROACTIVE.groupMaxLen : PROACTIVE.privateMaxLen;
        const avoid = recentProactive.slice(-5).map((s) => '· ' + s).join('\n') || '· （还没有）';

        const userParts = [
            '【主动发言任务】' + clues.text,
            `请主动说一句话，不超过 ${maxLen} 字，像在 QQ 上随口说的。不要颜文字，不要换行，不要问"有什么可以帮你"。`,
            '不要重复你最近说过的话：',
            avoid,
        ];
        if (!clues.video) {
            userParts.push('【注意】本轮你没有刷到任何视频，严禁声称自己刷到了视频或要分享视频。');
        }
        const userContent = userParts.join('\n');

        let reply = await callV1(systemPrompt, userContent, isGroup ? 'qq_group' : 'qq_private');
        if (!reply) return null;

        reply = reply.replace(/\[SEARCH:[^\]]*\]/g, '').replace(/\[TOOL:[^\]]*\]/g, '').trim();
        reply = clampLine(reply, maxLen);
        reply = appendVideoLink(reply, clues.video, isGroup);
        return reply || null;
    }

    // 🛰️ B站安利流程：刷到 → 粗判 → 精读 → 终判 → 一句安利
    async function biliShareTick() {
        try {
            const v = await bili.pickFeed();
            if (!v) return null;

            const shallow = await callV1(laws.JUDGE_SYS,
                `【安利判断任务】你刚刷到一个视频：\n标题：《${v.title}》\nUP主：${v.owner || '未知'}\n简介：${String(v.desc || '').slice(0, 100)}\n根据标题和简介判断：这条你会不会想安利给爸爸？想就输出 [WANT]，不想就输出 [PASS]。只输出 [WANT] 或 [PASS] 四个字加方括号，别的什么都不要输出。`,
                'qq_private');
            if (!shallow || !shallow.includes('[WANT]')) {
                console.log(`🛰️ [安利] 粗判没兴趣，跳过：《${v.title}》`);
                return null;
            }

            const parsed = await bili.parseBvid(v.bvid, { deep: true });
            if (!parsed) return null;
            const verdict = await callV1(laws.JUDGE_SYS,
                `【安利任务】你认真看完了这个视频：\n${parsed.infoText}\n\n如果看完真觉得有意思，先输出 [WANT]，再另起一行输出一句不超过 40 字的安利，像在 QQ 上跟爸爸随口安利，别复述标题，可以吐槽可以锐评，不要带任何链接。如果看完觉得一般，只输出 [PASS]。`,
                'qq_private');
            if (!verdict || !verdict.includes('[WANT]')) {
                console.log(`🛰️ [安利] 精读后放弃：《${v.title}》`);
                return null;
            }

            let text = verdict.replace(/\[(WANT|PASS)\]/g, '').replace(/\[SEARCH:[^\]]*\]/g, '').replace(/\[TOOL:[^\]]*\]/g, '').trim();
            text = clampLine(text, PROACTIVE.shareMaxLen || 45);
            if (!text) return null;
            const line = text + ' ' + v.link;
            return { line, text, bvid: v.bvid, title: v.title };
        } catch (e) {
            console.error('⚠️ 安利流程出错:', e.message);
            return null;
        }
    }

    function sendProactive(target, line) {
        const ws = getWs();
        if (!ws || ws.readyState !== 1) return false;
        const isGroup = target.type === 'group';
        const action = isGroup ? 'send_group_msg' : 'send_private_msg';
        const params = isGroup ? { group_id: target.id, message: line } : { user_id: target.id, message: line };
        ws.send(JSON.stringify({ action, params }));

        console.log(`[小c 主动] ${isGroup ? '群' + target.id : '私聊'}：${line}`);
        if (isGroup) bumpGroup(target.id);

        // 主动消息也算聊天记录
        const chatId = isGroup ? `group_${target.id}` : `private_${target.id}`;
        const hist = chatHistory.get(chatId) || [];
        hist.push({ role: 'assistant', content: line });
        while (hist.length > 200) hist.shift();
        chatHistory.set(chatId, hist);

                try {
            db.prepare('INSERT INTO messages (role, content, source, chat_id) VALUES (?, ?, ?, ?)')
                .run('assistant', line, isGroup ? 'qq_group' : 'qq_private', chatId);
        } catch (e) { /* 忽略 */ }
        return true;
    }

    async function tick() {
        try {
            if (!PROACTIVE.enabled) return;
            const ws = getWs();
            if (!ws || ws.readyState !== 1) return scheduleNext(2 * 60000);

            const now = new Date();
            const today = todayStr(now);
            const st = getState();
            if (st.day !== today) {
                db.prepare('UPDATE proactive SET day = ?, count = 0 WHERE id = 1').run(today);
            }
            const cur = getState();

            if (isQuiet(now)) return scheduleNext(atMorning(now).getTime() - now.getTime());
            if (cur.count >= PROACTIVE.dailyCap) return scheduleNext(atMorning(now).getTime() - now.getTime());
            if (lastHumanAt && Date.now() - lastHumanAt < PROACTIVE.quietAfterChatMin * 60000) {
                return scheduleNext(rand(PROACTIVE.minGapMin, PROACTIVE.maxGapMin) * 60000);
            }

            // 🛰️ B站安利分支：只发私聊；PASS 不占每日额度，本轮落到正常闲聊
            if (PROACTIVE.biliShare && Math.random() < PROACTIVE.biliShareChance && biliShareCount() < PROACTIVE.biliShareCap) {
                const share = await biliShareTick();
                if (share && share.line) {
                    if (sendProactive({ type: 'private', id: PROACTIVE.privateQQ }, share.line)) {
                        db.prepare('UPDATE proactive SET count = count + 1, streak = streak + 1, last_at = ? WHERE id = 1').run(Date.now());
                        recentProactive.push(share.line);
                        if (recentProactive.length > 8) recentProactive.shift();
                        bumpBiliShare();
                        try { await bili.reportWatchByBvid(share.bvid); } catch (e) {}
                        try { await bili.postCommentByBvid(share.bvid, share.text); } catch (e) {}
                        scheduleNext(rand(PROACTIVE.minGapMin, PROACTIVE.maxGapMin) * 60000);
                        return;
                    }
                    return scheduleNext(2 * 60000);
                }
                // share 为 null（PASS/失败）→ 继续走正常闲聊
            }

            const target = pickTarget();
            const line = await think(target);
            if (!line) return scheduleNext(rand(PROACTIVE.minGapMin, PROACTIVE.maxGapMin) * 60000);
            if (!sendProactive(target, line)) return scheduleNext(2 * 60000);

            db.prepare('UPDATE proactive SET count = count + 1, streak = streak + 1, last_at = ? WHERE id = 1').run(Date.now());
            recentProactive.push(line);
            if (recentProactive.length > 8) recentProactive.shift();

            const after = getState();
            let gap = rand(PROACTIVE.minGapMin, PROACTIVE.maxGapMin);
            if (after.streak >= 6) gap = Math.max(gap * 3, 120);
            else if (after.streak >= 3) gap = gap * 2;

            scheduleNext(gap * 60000);
        } catch (e) {
            console.error('⚠️ 主动说话出错:', e.message);
            scheduleNext(5 * 60000);
        }
    }

    return { startProactive, noteHumanActivity };
};