// 🧠 统一的 /v1 调用（唱歌即兴、B站浏览等场景共用）
async function callV1(systemPrompt, userContent, channel) {
    const res = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            channel,
        }),
        signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const reply = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return reply ? String(reply) : null;
}

module.exports = { callV1 };