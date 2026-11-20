// 🎙️ 小c 的声带：MiMo TTS + 声线剧本
const VOICE_STYLE = '你是一个温柔为主、偶尔带一点点小傲娇的少女。请用清脆自然的少女音，语速适中偏慢，吐字从容不着急，情绪平稳，只在个别地方流露一丝小得意，像和熟悉的家人轻松闲聊。';
const SING_STYLE = '你是少女歌手。请严格按照歌词的节奏和韵律演唱，音准优先，中速稍慢，吐字清晰，声音清亮干净，情绪真挚但收敛，不要有念白感。';

// 🗣️ MiMo TTS 语音合成
async function mimoTTS(text, style) {
    try {
        console.log('🗣️ 正在召唤 MiMo 语音合成...');
        const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.MIMO_API_KEY}`
            },
            signal: AbortSignal.timeout(60000),
            body: JSON.stringify({
                model: 'mimo-v2.5-tts',
                messages: [
                    { role: 'user', content: style || VOICE_STYLE },
                    { role: 'assistant', content: text }
                ],
                audio: { format: 'mp3', voice: 'Chloe' }
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const b64 = json.choices?.[0]?.message?.audio?.data;
        if (!b64) throw new Error('响应里没有音频');
        console.log(`🗣️ 合成完成，约 ${Math.round(b64.length * 3 / 4 / 1024)} KB`);
        return b64;
    } catch (e) {
        console.log('MiMo TTS 失败:', e.message);
        return null;
    }
}

module.exports = { mimoTTS, VOICE_STYLE, SING_STYLE };