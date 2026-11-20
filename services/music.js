// 🎵 点歌台：GD音乐台多源搜索 + 歌词 + 播放直链，网易云直连降级

// 🎵 点歌搜索：GD音乐台多源优先，被拦/挂了自动降级网易云直连
async function searchNeteaseMusic(keyword) {
    let searchKeyword = keyword.replace(/的/g, ' ').trim();
    // ① GD音乐台：多源轮询
    for (const src of ['netease', 'tencent', 'kuwo', 'migu']) {
        try {
            console.log(`🎵 GD音乐台[${src}]搜索: ${searchKeyword}`);
            const res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=search&source=${src}&name=${encodeURIComponent(searchKeyword)}&count=3&pages=1`, {
                signal: AbortSignal.timeout(8000),
                headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' }
            });
            const list = await res.json();
            if (!Array.isArray(list)) { console.log('GD被拦截，切换网易云直连'); break; }
            if (list.length === 0) { console.log(`GD[${src}]没搜到，换下一个源`); continue; }
            const s = list[0];
            let cover = '';
            try {
                const pRes = await fetch(`https://music-api.gdstudio.xyz/api.php?types=pic&source=${s.source || src}&id=${s.pic_id}&size=300`, { signal: AbortSignal.timeout(8000) });
                const pJson = await pRes.json();
                cover = (pJson && pJson.url) || '';
            } catch (e) {}
            const artist = (s.artist || []).join('/');
            console.log(`🎵 搜到了: ${s.name} - ${artist}`);
            return { id: s.id, name: s.name, artist, cover, source: s.source || src, urlId: s.url_id || s.id, lyricId: s.lyric_id || s.id };
        } catch (e) {
            console.log(`GD[${src}]不可用:`, e.message);
            break;
        }
    }
    // ② 网易云直连降级
    const apis = [
        `https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(searchKeyword)}&type=1&offset=0&total=true&limit=5`,
        `https://music.163.com/api/search/get?s=${encodeURIComponent(searchKeyword)}&type=1&limit=5`
    ];
    for (const api of apis) {
        try {
            console.log(`🎵 搜索网易云: ${searchKeyword}`);
            const res = await fetch(api, {
                signal: AbortSignal.timeout(8000),
                headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36', 'Referer': 'https://music.163.com', 'Cookie': 'os=pc' }
            });
            const json = await res.json();
            const songs = json.result && json.result.songs;
            if (songs && songs.length > 0) {
                let song = songs.find(s => s.name.includes(searchKeyword) || searchKeyword.includes(s.name)) || songs[0];
                const artist = song.artists.map(a => a.name).join('/');
                console.log(`🎵 搜到了: ${song.name} - ${artist}`);
                return { id: song.id, name: song.name, artist, cover: song.album ? song.album.picUrl : '', source: 'netease', urlId: song.id, lyricId: song.id };
            }
            console.log('🎵 接口通了，但没搜到结果');
            return null;
        } catch (e) {
            console.log('网易云接口失败:', e.message);
        }
    }
    return null;
}

// 🎼 真实歌词搜索：GD多源优先，网易云兜底
async function fetchNeteaseLyric(keyword) {
    try {
        const song = await searchNeteaseMusic(keyword);
        if (!song) return null;
        console.log(`🎼 曲库找到《${song.name}》- ${song.artist}，正在取歌词...`);
        let lrc = '';
        try {
            const res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=lyric&source=${song.source}&id=${song.lyricId}`, {
                signal: AbortSignal.timeout(8000),
                headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' }
            });
            const json = await res.json();
            lrc = (json && json.lyric) || '';
        } catch (e) {}
        if (!lrc && song.source === 'netease') {
            const res2 = await fetch(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`, {
                signal: AbortSignal.timeout(8000),
                headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36', 'Referer': 'https://music.163.com', 'Cookie': 'os=pc' }
            });
            const json2 = await res2.json();
            lrc = (json2.lrc && json2.lrc.lyric) || '';
        }
        if (!lrc) return null;
        const lines = lrc.split('\n')
            .map(l => l.replace(/\[[^\]]*\]/g, '').trim())
            .filter(l => l && !/^(作词|作曲|编曲|制作|演唱|混音|和声|吉他|键盘|贝斯|鼓|歌词|专辑|发行|出品)/.test(l));
        const full = lines.join(' ').replace(/\s+/g, ' ').trim();
        if (!full) return null;
        let clip = full.slice(0, 55);
        const cut = Math.max(clip.lastIndexOf('。'), clip.lastIndexOf('！'), clip.lastIndexOf('？'), clip.lastIndexOf('，'), clip.lastIndexOf('；'));
        if (cut > 20) clip = clip.slice(0, cut + 1);
        console.log(`🎼 歌词拿到了：${clip.slice(0, 20)}...`);
        return clip;
    } catch (e) {
        console.log('歌词获取失败:', e.message);
        return null;
    }
}

// 🎧 播放直链获取
async function gdGetPlayUrl(songInfo) {
    try {
        const res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=${songInfo.source}&id=${songInfo.urlId}&br=320`, {
            signal: AbortSignal.timeout(8000),
            headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' }
        });
        const json = await res.json();
        return (json && json.url) || '';
    } catch (e) {
        console.log('播放直链获取失败:', e.message);
        return '';
    }
}

module.exports = { searchNeteaseMusic, fetchNeteaseLyric, gdGetPlayUrl };