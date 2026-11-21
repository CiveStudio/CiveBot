// 🧰 通用工具：时间与文本

function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr(d) { d = d || new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function hhmm(d) { d = d || new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function toMin(s) { const p = String(s).split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); }

function clampLine(line, max) {
    line = String(line).replace(/\s+/g, ' ').trim();
    if (line.length <= max) return line;
    const cut = line.slice(0, max);
    const p = Math.max(
        cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
        cut.lastIndexOf('，'), cut.lastIndexOf('~'), cut.lastIndexOf('…')
    );
    return p > max * 0.5 ? line.slice(0, p + 1) : cut;
}

module.exports = { pad2, todayStr, hhmm, rand, toMin, clampLine };