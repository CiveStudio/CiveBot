// 👁️ 本地视觉之眼：MiniCPM-V 图片解析
async function parseImageLocally(imageUrl) {
    try {
        console.log('👀 正在呼叫本地视觉模型分析图片...');
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) throw new Error('下载图片失败');
        const arrayBuffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');

        const vRes = await fetch('http://127.0.0.1:8081/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "MiniCPM-V",
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: '请用一段话详细描述这张图片里的内容，包括画面主体、颜色、文字和情绪。' },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
                    ]
                }],
                stream: false,
                temperature: 0.1,
                top_p: 0.7
            })
        });

        if (!vRes.ok) throw new Error('本地视觉模型响应错误');
        const vJson = await vRes.json();
        return vJson.choices[0].message.content;
    } catch (e) {
        console.log('⚠️ 本地视觉解析失败(可能未启动)，将回退到云端看图:', e.message);
        return null;
    }
}

module.exports = { parseImageLocally };