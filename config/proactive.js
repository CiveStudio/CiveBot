// 🕰️ 主动说话引擎配置（群号改这里就行）
module.exports = {
    enabled: true,
    privateQQ: process.env.MY_QQ,
    groups: [
        // 想让她在群里主动说话，加一行：
        // { id: 123456789, name: '摸鱼群', dailyCap: 3 },
    ],
    minGapMin: 20,          // 黏人档：20–40 分钟
    maxGapMin: 40,
    dailyCap: 40,           // 每天最多主动说多少句
    groupDailyCap: 3,       // 每个群每天最多几句
    quietAfterChatMin: 10,  // 你刚聊完，10 分钟内不插嘴
    groupChance: 0.25,      // 有群的时候，多少次轮到群
    privateMaxLen: 30,
    groupMaxLen: 20,
    nightStart: '23:30',
    nightEnd: '08:00',
    // 🛰️ B站安利
    biliShare: true,        // 她"刷到好东西来安利你"总开关
    biliShareChance: 0.5,  // 每次到点，多大概率走安利流程
    biliShareCap: 5,        // 每天最多真安利几条（PASS 不占额度）
    shareMaxLen: 45,        // 安利语长度
    biliReport: true,       // 观看上报（喂她的推荐流）
    // 🌟 评论区@爸爸
    biliComment: true,      // 真·在B站评论区@你（一天最多x条）
    biliCommentCap: 3,      // 每天最多评论几条
    biliOwnerName: 'LouFoong',      // ← 【填这里】你的B站昵称，一字不差！不填就不评论
};