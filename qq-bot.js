// 🦔 小c 纯原生 QQ 网关 (V6.9 主动说话 + B站满血版)
const fs = require('fs');
const path = require('path');
const db = require('./db');

require('dotenv').config(); // 🌟 加载环境变量

const wsUrl = 'ws://127.0.0.1:6200'; 
const MY_QQ = process.env.MY_QQ; 
const BOT_QQ = process.env.BOT_QQ; 

let reconnectTimer = null;
let ws = null;
const chatHistory = new Map(); 
const pendingRequests = new Map();

const PROACTIVE = require('./config/proactive');

// 🌟 B站模块（放配置后面，把开关传给它）
const bili = require('./services/bili')(db, {
    reportWatch: PROACTIVE.biliReport,
    reportDailyCap: 3,
    commentEnabled: PROACTIVE.biliComment,
    commentCap: PROACTIVE.biliCommentCap,
    ownerName: PROACTIVE.biliOwnerName,
});

// 🧠 安利判定专用人设：不带聊天格式要求，只准出标签（修复"全PASS"问题）
const laws = require('./prompts/laws');
const persona = require('./prompts/persona');
const tts = require('./services/tts');
const music = require('./services/music');
const vision = require('./services/vision');
const { callV1 } = require('./services/llm');
const hormones = require('./services/hormones')(db);

const { clampLine } = require('./utils');
const webread = require('./services/webread')({ bili });
const proactive = require('./services/proactive')({
    db, bili, callV1, persona, laws, chatHistory,
    getWs: () => ws,
});

db.exec(`CREATE TABLE IF NOT EXISTS proactive (
    id INTEGER PRIMARY KEY,
    next_at INTEGER DEFAULT 0,
    day TEXT DEFAULT '',
    count INTEGER DEFAULT 0,
    streak INTEGER DEFAULT 0,
    last_at INTEGER DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS proactive_group (
    target TEXT PRIMARY KEY,
    day TEXT DEFAULT '',
    count INTEGER DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS bili_share (
    day TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0
)`);

// 🧠 重启后从数据库恢复会话记忆，让她记得你们聊过什么
function restoreHistory() {
    try {
        const rows = db.prepare(`SELECT chat_id, role, content FROM messages WHERE chat_id != '' ORDER BY id DESC LIMIT 600`).all();
        const buckets = new Map();
        for (const r of rows) {
            if (!buckets.has(r.chat_id)) buckets.set(r.chat_id, []);
            buckets.get(r.chat_id).push({ role: r.role, content: r.content });
        }
        for (const [id, arr] of buckets) {
            arr.reverse();
            chatHistory.set(id, arr.slice(-100));
        }
        if (buckets.size) console.log(`🧠 记忆恢复：${buckets.size} 个会话，共 ${rows.length} 条对话`);
    } catch (e) {
        console.log('⚠️ 记忆恢复失败:', e.message);
    }
}
function connect() {
    console.log('正在连接 NapCat WS...');
    ws = new WebSocket(wsUrl);

    ws.onopen = () => { 
        console.log('✅ 成功接入 NapCat！'); 
        proactive.startProactive();
    };

    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.echo && pendingRequests.has(data.echo)) {
                const resolve = pendingRequests.get(data.echo);
                resolve(data.data);
                pendingRequests.delete(data.echo);
                return;
            }

            let text = '', isAtMe = false, senderQQ = 0, senderName = '群友', isGroup = false, chatId = '';
            let imageUrl = null; 
            let coverImageUrl = null; 

            const parseMsg = async (msgArr) => {
                if (Array.isArray(msgArr)) {
                    for (const m of msgArr) {
                        if (m.type === 'text') text += m.data.text;
                        if (m.type === 'image') imageUrl = m.data.url || m.data.file;
                        if (m.type === 'at' && String(m.data.qq) === String(BOT_QQ)) isAtMe = true;
                        
                        if (m.type === 'reply' && m.data && m.data.id) {
                            const msgId = m.data.id;
                            const echoId = 'get_msg_' + Date.now();
                            ws.send(JSON.stringify({ action: "get_msg", params: { message_id: msgId }, echo: echoId }));
                            const result = await new Promise((resolve) => {
                                pendingRequests.set(echoId, resolve);
                                setTimeout(() => { if(pendingRequests.has(echoId)) resolve(null); }, 3000);
                            });
                            if (result && result.message) await parseMsg(result.message);
                        }
                    }
                } else if (typeof msgArr === 'string') {
                    text += msgArr.replace(/\[CQ:at,qq=\d+\]/g, '').replace(/\[CQ:image,.*?\]/g, '');
                    if (msgArr.includes(`[CQ:at,qq=${BOT_QQ}]`) || msgArr.includes(`[CQ:at,qq=${BOT_QQ}]`)) isAtMe = true;
                    const imgMatch = msgArr.match(/\[CQ:image,file=.*?url=(.*?)\]/);
                    if (imgMatch) imageUrl = imgMatch[1];
                }
            };

            if (data.post_type === 'message') {
                isGroup = data.message_type === 'group';
                chatId = isGroup ? `group_${data.group_id}` : `private_${data.user_id}`;
                senderQQ = data.user_id;
                senderName = data.sender?.card || data.sender?.nickname || '群友';
                await parseMsg(data.message);
            } else if (data.post_type === 'notice' && data.notice_type === 'notify' && data.sub_type === 'poke') {
                if (String(data.target_id) === String(BOT_QQ)) {
                    isGroup = data.group_id !== undefined;
                    chatId = isGroup ? `group_${data.group_id}` : `private_${data.user_id}`;
                    isAtMe = true; text = '(有人戳了戳你)';
                    senderQQ = data.user_id;
                                        senderName = isGroup
                        ? (data.sender?.card || data.sender?.nickname || '群友')
                        : (String(data.user_id) === String(MY_QQ) ? 'LouFung' : '群友');
                }
            }

                        // 🌟 有人说话就重置"被冷落"计数，并且 10 分钟内不主动插嘴
            if (chatId) {
                proactive.noteHumanActivity();
                hormones.onMessage(text);
            }

// 🌟 全局拦截 #LouFung 状态查询指令（群聊私聊通用，群聊免@）
text = text.trim();

// 🌟 私聊指令：发 QQ 空间（仅爸爸可用）
const qzoneMatch = text.match(/^去空间发(?:一段|个|条|布)?[:：\s]*[“"'「]?([\s\S]+?)[”"'」]?$/);
if (qzoneMatch && !isGroup && String(senderQQ) === String(MY_QQ)) {
    const content = qzoneMatch[1].trim();
    if (content) {
        ws.send(JSON.stringify({ action: 'send_qzone_msg', params: { content, ugc_right: 1 }, echo: 'qzone_' + Date.now() }));
        ws.send(JSON.stringify({ action: isGroup ? 'send_group_msg' : 'send_private_msg',
            params: isGroup ? { group_id: data.group_id, message: '发好啦～' } : { user_id: senderQQ, message: '发好啦～' } }));
        console.log(`[小c 空间] 已发送: ${content.slice(0, 30)}`);
        return;
    }
}

if (text === '#LouFung') {
    console.log('⚡ [指令触发] 收到 #LouFung，正在获取红米状态...');
    try {
        const sysRes = await fetch('http://127.0.0.1:3000/api/tools/sysinfo');
        const sysData = await sysRes.json();
        const sysStatus = sysData.status || '获取失败';

        // 直接发送格式化好的多行文本
        const action = isGroup ? 'send_group_msg' : 'send_private_msg';
        const params = isGroup ? { group_id: data.group_id, message: sysStatus } : { user_id: senderQQ, message: sysStatus };
        ws.send(JSON.stringify({ action, params }));
        console.log(`[小c 状态汇报] 已发送`);
    } catch (err) {
        console.error('❌ 获取状态失败:', err.message);
    }
    return; // 拦截，不往下走
}

if (!isGroup || isAtMe) {
    text = text.trim();
    if (text.includes('bilibili.com') || text.includes('b23.tv')) {
                    const biliData = await bili.parseLink(text);
                    if (biliData) {
                        text += `\n\n${biliData.infoText}`;
                        coverImageUrl = biliData.coverUrl; 
                    }
                } else if (text.match(/https?:\/\//)) {
                    const urlMatch = text.match(/https?:\/\/[^\s]+/);
                    if (urlMatch) {
                        const webData = await webread.parseGeneralLink(urlMatch[0]);
                        if (webData) text += `\n\n${webData}`;
                    }
                }

                                const musicMatch = text.match(/点歌\s*[:：]?\s*(.+)/);
                if (musicMatch) {
                    const songName = musicMatch[1].trim();
                    console.log(`触发点歌: ${songName}`);
                    const sendMsg = (message) => ws.send(JSON.stringify({
                        action: isGroup ? 'send_group_msg' : 'send_private_msg',
                        params: isGroup
                            ? { group_id: data.group_id, message }
                            : { user_id: senderQQ, message }
                    }));

                    const songInfo = await music.searchNeteaseMusic(songName);
                                        if (songInfo) {
                        console.log('🎵 发送点歌结果...');
                        let playUrl = await music.gdGetPlayUrl(songInfo);
                        // 只发卡片，不发文字
                        sendMsg([{ type: 'music', data: {
                            type: 'custom',
                            url: `https://music.163.com/song?id=${songInfo.id}`,
                            audio: playUrl || `https://music.163.com/song/media/outer/url?id=${songInfo.id}.mp3`,
                            title: songInfo.name,
                            content: `歌手：${songInfo.artist}`,
                            image: songInfo.cover
                        } }]);
                        // 卡片后追加完整音频：下载到public让NapCat走本地HTTP取，绕过文件系统边界
                        if (playUrl) {
                            console.log('🎵 下载完整音频到本地...');
                            try {
                                const audioRes = await fetch(playUrl, { signal: AbortSignal.timeout(60000) });
                                if (!audioRes.ok) throw new Error(`HTTP ${audioRes.status}`);
                                const buf = Buffer.from(await audioRes.arrayBuffer());
                                if (buf.length < 100 * 1024) throw new Error(`文件过小(${Math.round(buf.length/1024)}KB)`);
                                const cacheDir = path.join(__dirname, 'public', 'cache_music');
                                fs.mkdirSync(cacheDir, { recursive: true });
                                for (const f of fs.readdirSync(cacheDir)) {
                                    const fp = path.join(cacheDir, f);
                                    if (Date.now() - fs.statSync(fp).mtimeMs > 600000) { try { fs.unlinkSync(fp); } catch (e) {} }
                                }
                                const fileName = `${Date.now()}.mp3`;
                                fs.writeFileSync(path.join(cacheDir, fileName), buf);
                                console.log(`🎵 下载完成 ${Math.round(buf.length / 1048576 * 10) / 10}MB，经本地HTTP交给NapCat...`);
                                sendMsg([{ type: 'file', data: { file: `http://127.0.0.1:3000/cache_music/${fileName}`, name: `《${songInfo.name}》-${songInfo.artist}.mp3` } }]);
                            } catch (e) {
                                console.log('🎵 本地下载失败，降级为远程直链:', e.message);
                                sendMsg([{ type: 'file', data: { file: playUrl, name: `《${songInfo.name}》-${songInfo.artist}.mp3` } }]);
                            }
                        }
                    } else {
                        console.log('🎵 没搜到，回复提示');
                        sendMsg([{ type: 'text', data: { text:
                            `哼，《${songName}》？本小姐翻遍曲库都没找到，你是不是打错名字了。`
                        } }]);
                    }
                    return;
                }

                let wantVoiceReply = false;
                let voiceStyleOverride = null;
                const voiceMatch = text.match(/^语音说\s*[:：]?\s*(.+)/);
                if (voiceMatch) {
                    text = voiceMatch[1].trim();
                    wantVoiceReply = true;
                    console.log(`触发语音模式，让小c自己想：${text}`);
                }
                
                if (!text && !imageUrl && !coverImageUrl) return;

                console.log(`[收到消息] ${isGroup ? '群' : '私聊'} - ${senderName}: ${text || '[图片/封面]'}`);

                const systemPrompt = persona.buildSystemPrompt(isGroup, senderName);

                let history = chatHistory.get(chatId) || [];
                let currentUserContent = [];
                let localVisionDesc = null;

                if (imageUrl) {
                    localVisionDesc = await vision.parseImageLocally(imageUrl);
                }

                if (localVisionDesc) {
                    currentUserContent.push({ type: 'text', text: `${text}\n\n【本地视觉系统传来的图片描述】：\n${localVisionDesc}` });
                } else {
                    if (text) currentUserContent.push({ type: 'text', text: text });
                    if (imageUrl) currentUserContent.push({ type: 'image_url', image_url: { url: imageUrl } });
                }
                
                if (coverImageUrl) currentUserContent.push({ type: 'image_url', image_url: { url: coverImageUrl } });
                if (currentUserContent.length === 0) return;

                let messages = [
                    { role: 'system', content: systemPrompt },
                    ...history,
                    { role: 'user', content: currentUserContent }
                ];

                try {
                    const res = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ messages: messages, channel: isGroup ? 'qq_group' : 'qq_private', chatId: chatId, senderName: senderName, hormones: hormones.snapshot() + ' ' + (hormones.guidance() || '') })
                    });
                    const json = await res.json();
                    
                    if (!json.choices || !json.choices[0]) return;
                    let reply = json.choices[0].message.content;
                                        // 🗣️ 拦截 [VOICE]：她自己决定用语音回答
                    if (reply.includes('[VOICE]')) {
                        reply = reply.replace(/\[VOICE\]/g, '').trim();
                        wantVoiceReply = true;
                        console.log('🗣️ 小c自己决定用语音回复');
                    }
                                        // 🎤 拦截 [SING:歌名]：先去曲库查真实歌词再唱
                    const singMatch = reply.match(/\[SING[:：]\s*([^\]]+)\]/);
                    if (singMatch) {
                        const singName = singMatch[1].trim();
                        console.log(`🎤 点唱《${singName}》，去找真实歌词...`);
                        const isImprov = /即兴|自编|随便/.test(singName);
                        let lyricClip = isImprov ? null : await music.fetchNeteaseLyric(singName);
                        if (lyricClip) {
                            reply = `(唱歌)${lyricClip}`;
                            voiceStyleOverride = tts.SING_STYLE;
                        } else {
                            console.log('🎤 曲库没找到，小c自己即兴编词...');
                            try {
                                const made = await callV1(laws.JUDGE_SYS, `爸爸想让你唱《${singName}》，但曲库里找不到这首歌的歌词。请你即兴编一段清唱歌词（30~60字，完整连贯，可以化用歌名的意境），只输出歌词本身，不要解释，不要书名号。`, 'qq_private');
                                reply = `(唱歌)${String(made || '').replace(/\n+/g, ' ').trim()}`;
                                voiceStyleOverride = tts.SING_STYLE;
                            } catch (e) {}
                        }
                        if (reply && reply !== '(唱歌)') {
                            wantVoiceReply = true;
                            console.log('🎤 唱词已就位');
                        } else {
                            reply = '呜…词库翻遍了也没找到，爸爸换个歌让我唱嘛。';
                        }
                    }
                    // 拦截搜索
                    const searchMatch = reply.match(/\[SEARCH:(.+?)\]/);
                    if (searchMatch) {
                        const query = searchMatch[1].trim();
                        console.log(`[触发静默搜索] 查询词: ${query}`);
                        try {
                            const aiConfigPath = path.join(__dirname, 'public', 'ai-config.json');
                            const aiConfig = JSON.parse(fs.readFileSync(aiConfigPath, 'utf8'));
                            const deepseekProvider = aiConfig.providers.find(p => p.webTools) || aiConfig.providers.find(p => p.apiUrl && p.apiUrl.includes('deepseek'));
                            const apiKey = deepseekProvider.apiKey;
                            
                            const searchRes = await fetch('https://api.deepseek.com/v1/tools/search', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                                body: JSON.stringify({ query: query, count: 5, need_content: false })
                            });
                            const searchData = await searchRes.json();
                            const results = searchData.results || [];
                            const searchContext = results.map(r => `【${r.title}】${r.summary}\n链接：${r.url}`).join('\n\n');
                            
                            messages.push({ role: 'assistant', content: reply });
                            messages.push({ role: 'user', content: `【系统为你搜索到了以下信息】：\n${searchContext}\n\n【请根据以上信息简短回答用户。如需给爸爸链接，只能原样使用上面给出的链接，严禁自己编造BV号或任何链接】：${text}` });
                            
                            const finalRes = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ messages: messages, channel: isGroup ? 'qq_group' : 'qq_private', senderName: senderName })
                            });
                            const finalJson = await finalRes.json();
                            reply = finalJson.choices[0].message.content;
                        } catch (searchErr) {
                            reply = "唔…网线好像被拔了，小c查不到数据。爸爸出门记得多穿点哦🍎";
                        }
                    }

// 🌟 拦截"刷个视频给我"指令：给她真链接，杜绝编造
if (reply.includes('[TOOL:BILI_PICK]')) {
    console.log('⚡ [Agent执行] 拦截到刷B站指令，正在抽一条真实的...');
    reply = reply.replace('[TOOL:BILI_PICK]', '').trim();
    try {
        const picked = await bili.pickFeed();
        if (picked) {
            messages.push({ role: 'assistant', content: reply });
            messages.push({ role: 'user', content: `【系统提示：你刚刚真的刷到了下面这个视频，以下全是真实信息：\n标题：《${picked.title}》\nUP主：${picked.owner || '未知'}\n简介：${String(picked.desc || '').slice(0, 80)}\n真实链接（发给爸爸时只能原样用它，严禁改动）：${picked.link}\n请用你的傲娇语气把这条视频分享给爸爸，介绍一句话，句尾原样带上这个链接。` });
            const pickRes = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: messages, channel: isGroup ? 'qq_group' : 'qq_private', senderName: senderName })
            });
            const pickJson = await pickRes.json();
            if (pickJson.choices && pickJson.choices[0]) reply = pickJson.choices[0].message.content;
            reply = String(reply || '').replace(/\[SEARCH:[^\]]*\]/g, '').replace(/\[TOOL:[^\]]*\]/g, '').trim();
            if (!reply.includes(picked.link)) reply = reply + ' ' + picked.link;
            // 🌟 看过的也算数：上报观看（受每日上限约束）
            try { await bili.reportWatchByBvid(picked.bvid); } catch (e) {}
        } else {
            reply = "唔…刷了半天没刷到喜欢的，等会儿再试嘛！哼！";
        }
    } catch (pickErr) {
        reply = "呜…小c的爪爪抽风了，没刷到，哼。";
    }
}

// 🌟 拦截"去刷会儿B站"：完整浏览模式——抓一把→挑两个→深读→选一个→评论区@爸爸
if (reply.includes('[TOOL:BILI_BROWSE]')) {
    console.log('⚡ [Agent执行] 拦截到浏览B站指令，开始逛...');
    reply = reply.replace('[TOOL:BILI_BROWSE]', '').trim();
    try {
        const list = await bili.pickFeedList(6);
        if (!list.length) {
            reply = "唔…今天刷来刷去都是看过的，换个时间再来嘛！哼！";
        } else {
            const menu = list.map((v, i) => `${i + 1}. 《${v.title}》（${v.owner || '未知'}）简介：${String(v.desc || '').slice(0, 50)}`).join('\n');
            const pickRes = await callV1(laws.JUDGE_SYS, `【浏览任务】你刚才逛B站，看到这些视频：\n${menu}\n\n哪几个你有点想点进去看？输出 [PICK] 加序号，比如 [PICK]1,3。最多选2个，最少1个。只输出这个，别的不要。`, 'qq_private');
            const m = String(pickRes || '').match(/\[PICK\]\s*([\d,\s]+)/);
            let idxs = m ? m[1].split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= list.length).slice(0, 2) : [];
            if (!idxs.length) idxs = [Math.floor(Math.random() * list.length) + 1];

            const chosen = [];
            for (const i of idxs) {
                const cand = list[i - 1];
                const parsed = await bili.parseBvid(cand.bvid, { deep: true });
                if (parsed) chosen.push({ cand, parsed });
            }
            if (!chosen.length) {
                reply = "唔…点进去两个都觉得一般，今天手气不行，哼。";
            } else {
                const detail = chosen.map((c, i) => `候选${i + 1}：《${c.cand.title}》\n${c.parsed.infoText}`).join('\n\n');
                const final = await callV1(laws.JUDGE_SYS, `【最终任务】你深读了这些视频：\n${detail}\n\n选出你真觉得最有意思的一条：先输出 [BEST] 加数字（候选几），再另起一行输出一段不超过 50 字的感想，写你的真实看法，可以吐槽。`, 'qq_private');
                const fm = String(final || '').match(/\[BEST\]\s*(\d+)/);
                let bi = fm ? parseInt(fm[1], 10) : 1;
                if (!(bi >= 1 && bi <= chosen.length)) bi = 1;
                const win = chosen[bi - 1];
                let thought = String(final || '').replace(/\[BEST\]\s*\d+/g, '').replace(/\[(WANT|PASS|PICK)\]/g, '').replace(/\[SEARCH[^\]]*\]/g, '').replace(/\[TOOL[^\]]*\]/g, '').trim();
                thought = clampLine(thought, 60) || `《${win.cand.title}》这个有点东西！`;
                let commented = false;
                try { commented = await bili.postCommentByBvid(win.cand.bvid, thought); } catch (e) {}
                try { await bili.reportWatchByBvid(win.cand.bvid); } catch (e) {}
                bili.markSeen(win.cand.bvid);
                reply = `逛完啦！${thought} ${commented ? '已经在评论区@你了，去收通知！' : '链接在这：'} ${win.cand.link}`;
            }
        }
    } catch (browseErr) {
        reply = "呜…逛B站逛晕了，改天再逛。";
    }
}

                    // 🌟 新增：拦截查服务器状态指令
if (reply.includes('[TOOL:SYS_INFO]')) {
    console.log('⚡ [Agent执行] 拦截到查状态指令，正在获取红米系统信息...');
    reply = reply.replace('[TOOL:SYS_INFO]', '').trim();
    try {
        const sysRes = await fetch('http://127.0.0.1:3000/api/tools/sysinfo');
        const sysData = await sysRes.json();
        const sysStatus = sysData.status || '获取失败';
        
        // 拿到真实数据后，让云端大脑重新组织语言
        messages.push({ role: 'assistant', content: reply || "等我查查..." });
        messages.push({ role: 'user', content: `【系统提示：这是红米服务器的真实状态：${sysStatus}。请用傲娇的语气向爸爸汇报，并提醒他注意散热或充电。】` });
        
        const sysFinalRes = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: messages, channel: isGroup ? 'qq_group' : 'qq_private', senderName: senderName })
        });
        const sysFinalJson = await sysFinalRes.json();
        reply = sysFinalJson.choices[0].message.content;
    } catch (sysErr) {
        reply = "呜…小c查不到服务器状态，可能线缆松了。";
    }
}

// 🌟 优先级3：拦截重写日记指令
if (reply.includes('[TOOL:REWRITE_DIARY]')) {
    console.log('⚡ [Agent执行] 拦截到重写日记指令，正在呼叫 server.js 覆盖并重新生成...');
    reply = reply.replace('[TOOL:REWRITE_DIARY]', '').trim();
    fetch('http://127.0.0.1:3000/api/journal/write?force=true', { method: 'POST' })
        .then(r => console.log('✅ 重写日记任务已提交后台'))
        .catch(e => console.error('❌ 触发重写日记失败:', e.message));
}

// 拦截普通写日记指令
if (reply.includes('[TOOL:WRITE_DIARY]')) {
    console.log('⚡ [Agent执行] 拦截到写日记指令，正在呼叫 server.js...');
    reply = reply.replace('[TOOL:WRITE_DIARY]', '').trim();
    fetch('http://127.0.0.1:3000/api/journal/write', { method: 'POST' })
        .then(r => console.log('✅ 日记生成任务已提交后台'))
        .catch(e => console.error('❌ 触发日记生成失败:', e.message));
}

// 清理换行
reply = reply.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
                    
                                        if (isGroup && reply.length > 60 && !reply.includes('```')) {
                        // 🔗 链接保护：群聊截断时别腰斩 URL
                        const urls = reply.match(/https?:\/\/\S+/g) || [];
                        let body = reply.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
                        const subReply = body.substring(0, 60);
                        const lastPunc = Math.max(subReply.lastIndexOf('。'), subReply.lastIndexOf('！'), subReply.lastIndexOf('？'), subReply.lastIndexOf('!'), subReply.lastIndexOf('?'), subReply.lastIndexOf('~'), subReply.lastIndexOf('～'));
                        if (lastPunc > 20) body = subReply.substring(0, lastPunc + 1);
                        else body = subReply.substring(0, 50);
                        reply = urls.length ? body + ' ' + urls[urls.length - 1] : body;
                    }

                    if (!reply) reply = "哼，本刺猬已经去办了！";

                    history.push({ role: 'user', content: text || '[图片/链接]' });
                    history.push({ role: 'assistant', content: reply });
                    // 🌟 缓存优化④：只增不减，攒到 200 条再滑，保住前缀缓存
                    if (history.length > 200) history = history.slice(-160);
                    chatHistory.set(chatId, history);

                    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
                    if (wantVoiceReply) {
                        console.log('🗣️ 语音模式：把小c的回复变成声音...');
                        const audioB64 = await tts.mimoTTS(reply, voiceStyleOverride);
                        if (audioB64) {
                            const params = isGroup
                                ? { group_id: data.group_id, message: [{ type: 'record', data: { file: `base64://${audioB64}` } }] }
                                : { user_id: senderQQ, message: [{ type: 'record', data: { file: `base64://${audioB64}` } }] };
                            ws.send(JSON.stringify({ action, params }));
                            console.log(`[小c 语音回复] ${reply}`);
                        } else {
                            const params = isGroup ? { group_id: data.group_id, message: reply } : { user_id: senderQQ, message: reply };
                            ws.send(JSON.stringify({ action, params }));
                            console.log(`[小c 回复(语音降级)] ${reply}`);
                        }
                    } else {
                        const params = isGroup ? { group_id: data.group_id, message: reply } : { user_id: senderQQ, message: reply };
                        ws.send(JSON.stringify({ action, params }));
                        console.log(`[小c 回复] ${reply}`);
                    }

                } catch (err) {
                    console.error('❌ 请求失败:', err.message);
                }
            }
        } catch (e) { console.error('解析消息出错:', e.message); }
    };

    ws.onclose = () => { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 5000); };
}

setInterval(() => hormones.tick(), 10 * 60 * 1000);
restoreHistory();
connect();