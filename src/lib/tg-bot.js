// ============================================================================
// src/lib/tg-bot.js
// Telegram bot 的全部业务逻辑。
//
// 本文件**不 import 任何 Cloudflare / Next 专有模块** ——
// Telegram 调用通过 createTg() 注入，数据库通过参数传入。
// 这样可以直接用 node 的真 SQLite 跑集成测试（见 tests/）。
//
// 新增/用到的两张表（运行时自动创建，无需手工执行 SQL）：
//   botstate(key TEXT PRIMARY KEY, value TEXT)
//       —— 存各种"上次到哪儿了"的标记（播报位点、体检状态、webhook 地址）
//          （历史上还用过 usage_msg_id / usage_pin_msg_id 记录"上一条使用说明"，
//            随该功能一起删除了；如果旧库里还留着这两行，属于无害的历史残留。）
//   tgmsg(file_id TEXT PRIMARY KEY, chat_id TEXT, message_id INTEGER, kind TEXT, ts TEXT)
//       —— file_id ↔ 频道消息 message_id 的映射。删图要靠它定位消息。
//
// ⚠️ 为什么不用时间做筛选：已有的 imginfo.time 列存的是
//    "2026年9月18日 11:30:00" 这种中文本地化字符串（给后台显示用），
//    SQL 里没法可靠地按日期比较。所以一律用自增的 id 当"位点"。
// ============================================================================

import {
  UA,
  MAX_PHOTO_BYTES,
  MAX_OTHER_BYTES,
  escapeHtml,
  nowTimeString,
  shanghaiDate,
  extractFileIdFromPost,
  kindOfPost,
  dbUrlOf,
  parseFileRef,
  mimeToExt,
  toCsv
} from './tg-common.js';
import { purgeFileCache } from './tg-serve.js';

// ---------------------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------------------

// 用 WeakSet 记住"这个 db 已经建过表了"，避免每次请求都跑 DDL。
// （不能用普通的布尔开关：测试时会创建多个不同的库。）
const schemaDone = new WeakSet();

export async function ensureSchema(db) {
  if (!db) return false;
  if (schemaDone.has(db)) return true;
  try {
    await db.prepare(
      'CREATE TABLE IF NOT EXISTS botstate (key TEXT PRIMARY KEY, value TEXT)'
    ).run();
    await db.prepare(
      'CREATE TABLE IF NOT EXISTS tgmsg (' +
      'file_id TEXT PRIMARY KEY, chat_id TEXT, message_id INTEGER, kind TEXT, ts TEXT)'
    ).run();
    schemaDone.add(db);
    return true;
  } catch (e) {
    console.error('ensureSchema failed:', e && e.message);
    return false;
  }
}

export async function getState(db, key) {
  if (!db) return null;
  try {
    const r = await db.prepare('SELECT value FROM botstate WHERE key = ?').bind(key).first();
    return r ? r.value : null;
  } catch (e) {
    return null;
  }
}

export async function setState(db, key, value) {
  if (!db) return false;
  try {
    await db.prepare('INSERT OR REPLACE INTO botstate (key, value) VALUES (?, ?)')
      .bind(key, String(value)).run();
    return true;
  } catch (e) {
    console.error('setState failed:', e && e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Telegram 调用
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 发出前的文本兜底：把"被转义的表情"还原回真字符
// ---------------------------------------------------------------------------
//
// 背景（2026-09-18，业主实测反馈）：
//   源码里这一行是**真实的表情字符**（一个相机图标）：
//       '<emoji> <b>图床管理助手</b>'
//   但业主在 Telegram 里收到的却是一串「反斜杠 + u + 4 位十六进制」形式的字面文本。
//   也就是说：从"源码"到"最终发出去的字符串"之间，有某一环把表情转义成了
//   反斜杠形式（最可能是粘贴进 GitHub 的过程中被某个工具转义了）。
//
// 处理方式：不去猜是哪一环转的，也不指望以后不再发生，
//   直接在**发出前**做一次还原 —— 文本里凡是出现 \uXXXX / \UXXXXXXXX
//   （不管前面有几个反斜杠），就还原成真字符。
//   没有转义时它什么都不做，所以对正常消息零影响。
//
// ⚠️ 这里**故意不在源码里写反斜杠字面量**，而是用 String.fromCharCode(92) 拼出来 ——
//    因为"反斜杠被再转义一次"正是我们要防的那个毛病：如果这里写死一个反斜杠，
//    它自己也会被一起转义，兜底就失效了。这不是炫技，是被现实逼的。
const BACKSLASH = String.fromCharCode(92);                       // 就是 \ 这个字符
// ⚠️ 正则里要匹配"字面反斜杠"，得写成 \\+（两个反斜杠 + 加号）；
//    只写 \+ 在正则里是"一个字面加号"，不匹配反斜杠 —— 所以这里要 BACKSLASH 两次。
const RE_U4 = new RegExp(BACKSLASH + BACKSLASH + '+u([0-9a-fA-F]{4})', 'g'); // 四位十六进制那种
const RE_U8 = new RegExp(BACKSLASH + BACKSLASH + '+U([0-9a-fA-F]{8})', 'g'); // \U0001F4F7 这种

/**
 * 把文本里"被写成了转义形式"的字符还原成真字符。
 * 例：把写成「反斜杠+u+4位十六进制」形式的两段，还原成 1 个表情字符。
 */
export function unescapeEmoji(s) {
  if (s == null) return s;
  const str = String(s);
  if (str.indexOf(BACKSLASH) === -1) return str;   // 快路径：绝大多数消息直接原样返回
  return str
    .replace(RE_U8, (whole, hex) => {
      const cp = parseInt(hex, 16);
      return (cp > 0x10ffff) ? whole : String.fromCodePoint(cp);
    })
    .replace(RE_U4, (whole, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * 把要发给 Telegram 的 payload 里所有"给用户看的文本"过一遍上面的还原。
 * 覆盖：text、caption，以及行内键盘的按钮文字。
 */
function fixOutgoing(payload) {
  const out = Object.assign({}, payload || {});
  if (typeof out.text === 'string') out.text = unescapeEmoji(out.text);
  if (typeof out.caption === 'string') out.caption = unescapeEmoji(out.caption);
  if (out.reply_markup && Array.isArray(out.reply_markup.inline_keyboard)) {
    out.reply_markup = Object.assign({}, out.reply_markup, {
      inline_keyboard: out.reply_markup.inline_keyboard.map((row) =>
        (Array.isArray(row) ? row : []).map((btn) => {
          const b = Object.assign({}, btn);
          if (typeof b.text === 'string') b.text = unescapeEmoji(b.text);
          return b;
        })
      )
    });
  }
  return out;
}

export function createTg({ token, fetchImpl = fetch }) {
  const base = `https://api.telegram.org/bot${token}`;

  async function parse(res) {
    try {
      return await res.json();
    } catch (e) {
      return { ok: false, description: `Telegram 返回了非 JSON 响应（HTTP ${res.status}）` };
    }
  }

  return {
    token,
    /** 普通 JSON 调用（发出前会把被转义的表情还原，见 unescapeEmoji） */
    async call(method, payload) {
      const res = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(fixOutgoing(payload))
      });
      return parse(res);
    },
    /** 需要上传文件时用（multipart） */
    async callForm(method, form) {
      const res = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        headers: { 'User-Agent': UA },
        body: form
      });
      return parse(res);
    }
  };
}

async function reply(tg, chatId, text, extra) {
  try {
    return await tg.call('sendMessage', Object.assign({
      chat_id: String(chatId),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, extra || {}));
  } catch (e) {
    console.error('reply failed:', e && e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 命令（⚠️ 不再注册成 Telegram 菜单）
// ---------------------------------------------------------------------------
//
// ⚠️ 这份列表**不再往 Telegram 注册菜单**（2026-09-18 起，业主主动要求）。
//    理由：他的群里有别的机器人，一输入 / 就弹出一长串命令，太乱。
//    现在它的用途是两个：
//      ① 作为「这个 bot 有哪些命令」的唯一权威清单（给文档与测试用）；
//      ② setupBot() 用它报出「还有几条命令可用」。
//    命令本身**一个都没删**，只是不再出现在 / 菜单里 —— 需要时私聊手打即可。

export const BOT_COMMANDS = [
  { command: 'start', description: '使用说明' },
  { command: 'help', description: '使用说明' },
  { command: 'stats', description: '统计（可带图片链接看单张）' },
  { command: 'del', description: '下架某张图片' },
  { command: 'export', description: '导出全部链接清单（CSV）' },
  { command: 'sync', description: '把最近的频道消息补进数据库' },
  { command: 'health', description: '立刻做一次体检' },
  { command: 'id', description: '查看当前会话 ID（配置用）' }
];

function helpText(origin) {
  return [
    '📷 <b>图床管理助手</b>',
    '',
    '上传请走网页端；这里是管理已上传图片的入口。',
    '',
    '<b>可用命令</b>',
    '/stats — 总体统计',
    '/stats &lt;链接&gt; — 看单张图片的访问量',
    '/del &lt;链接&gt; — 下架某张图（同时清数据库和缓存）',
    '/export — 导出全部链接清单（CSV 文件）',
    '/sync — 把最近的频道消息补进数据库',
    '/health — 立刻做一次体检',
    '/id — 查看当前会话 ID（配置用）',
    '',
    '<b>不想记命令？</b>在频道的讨论组里，回复某张图并发送「删除」即可下架。',
    '',
    `图床地址：${escapeHtml(origin)}`
  ].join('\n');
}

// 注：原本这里还有一个 channelUsageText()，用来生成「发到频道并置顶」的说明文字。
// 该功能已彻底删除（原因见 setupBot() 里的注释），函数一并移除，
// 以保证这段文字**不存在于代码里**、不可能再被发出去。
// 频道里的用法说明统一走私聊 /help（见上面的 helpText()）。

// ---------------------------------------------------------------------------
// 频道消息 → 落库
// ---------------------------------------------------------------------------

/**
 * 往 imginfo 里写一条图片记录。**所有写入口都必须走这里**，因为这里把
 * "上传接口"和"webhook 补录"这对并发写者之间的竞争处理掉了。
 *
 * 背景（这是本项目最容易踩的一个坑）：
 *   图片一进频道，Telegram 会**立刻**把这条 channel_post 推给 webhook，
 *   于是同一时刻有两个人在写同一个 url：
 *     - 上传接口：手里有真实数据（真实 referer / IP / 时间）
 *     - webhook ：只知道"有这么个文件"，写一条占位记录
 *   原来的写法两边都是无条件 INSERT，而 imginfo.url 上并没有唯一约束，
 *   于是同一张图会变成两行，后台列表里就出现重复条目。
 *
 * 两种模式：
 *   mode='authoritative'（上传接口用）—— 真实数据优先。
 *        先 UPDATE 已存在的行；没有才 INSERT（且 INSERT 也带存在性判断）；
 *        万一两个 INSERT 插肩而过，最后再 UPDATE 一次把真实数据盖上去。
 *        结果：任何交错顺序下都只有一行，且内容一定是真实的。
 *   mode='placeholder'（webhook 补录用）—— 只补空缺，绝不覆盖已有数据。
 *        一条原子的 INSERT ... WHERE NOT EXISTS 就够。
 *
 * total 的处理：占位行写 0；真实上传写 1，但**不会**把已有的访问量重置回 1。
 */
export async function saveImageInfo({
  db, url, referer, ip, rating, time, total = 1, mode = 'authoritative'
}) {
  if (!db) return { written: false, reason: 'no-db' };

  if (mode === 'placeholder') {
    const r = await db.prepare(
      'INSERT INTO imginfo (url, referer, ip, rating, total, time) ' +
      'SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM imginfo WHERE url = ?)'
    ).bind(url, referer, ip, rating, total, time, url).run();
    const wrote = (r && r.meta && r.meta.changes) || 0;
    return { written: wrote > 0, reason: wrote > 0 ? 'inserted' : 'already-exists' };
  }

  // ---- mode = 'authoritative' ----
  const upd = () => db.prepare(
    'UPDATE imginfo SET referer = ?, ip = ?, rating = ?, time = ?, ' +
    'total = CASE WHEN COALESCE(total, 0) < ? THEN ? ELSE total END ' +
    'WHERE url = ?'
  ).bind(referer, ip, rating, time, total, total, url).run();

  const first = await upd();
  if (((first && first.meta && first.meta.changes) || 0) > 0) {
    return { written: true, reason: 'updated' };
  }

  const ins = await db.prepare(
    'INSERT INTO imginfo (url, referer, ip, rating, total, time) ' +
    'SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM imginfo WHERE url = ?)'
  ).bind(url, referer, ip, rating, total, time, url).run();
  if (((ins && ins.meta && ins.meta.changes) || 0) > 0) {
    return { written: true, reason: 'inserted' };
  }

  // 走到这里说明"我们判断不存在"和"我们插入"之间，webhook 抢先插了一条占位行。
  // 再更新一次，把真实数据盖上，避免留下一行 total=0 / referer="Telegram 频道"。
  await upd();
  return { written: true, reason: 'merged' };
}

/**
 * 把频道里的一条消息登记进数据库。
 * 幂等：同一条消息重复处理不会产生重复记录。
 */
export async function recordChannelPost({ post, env, db }) {
  if (!db) return { logged: false, reason: 'no-db' };
  await ensureSchema(db);

  const fileId = extractFileIdFromPost(post);
  if (!fileId) return { logged: false, reason: 'no-file' };

  const kind = kindOfPost(post);
  await db.prepare(
    'INSERT OR REPLACE INTO tgmsg (file_id, chat_id, message_id, kind, ts) VALUES (?, ?, ?, ?, ?)'
  ).bind(fileId, String(post.chat.id), post.message_id, kind, new Date().toISOString()).run();

  // 老图补录：只知道它存在，不知道当初谁传的、被看过几次。
  // total 记 0（不用 1）—— 首页那个数字走的是 COUNT(*)，不受影响。
  // rating 记 -1 = 未检测（后台那个开关只认 === 3，所以 -1 显示为"关"）。
  try {
    const r = await saveImageInfo({
      db,
      url: dbUrlOf(fileId),
      referer: 'Telegram 频道',
      ip: 'unknown',
      rating: -1,
      total: 0,
      time: nowTimeString(),
      mode: 'placeholder'   // 已有真实记录时绝不覆盖
    });
    if (!r.written) return { logged: false, reason: 'known', fileId };
  } catch (e) {
    return { logged: false, reason: 'insert-failed', fileId, error: e && e.message };
  }
  return { logged: true, reason: 'new', fileId, kind };
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

export async function deleteImage({ fileId, env, tg, db, origin, cachesImpl = null }) {
  await ensureSchema(db);
  const out = {
    fileId,
    messageDeleted: false,
    messageId: null,
    dbRowsRemoved: 0,
    cachePurged: 0,
    notes: []
  };

  // 1) 删频道里的那条消息
  let row = null;
  try {
    row = await db.prepare('SELECT chat_id, message_id FROM tgmsg WHERE file_id = ?').bind(fileId).first();
  } catch (e) {
    out.notes.push('查 tgmsg 失败：' + (e && e.message));
  }

  if (row && row.message_id) {
    out.messageId = row.message_id;
    const del = await tg.call('deleteMessage', {
      chat_id: String(row.chat_id),
      message_id: row.message_id
    });
    out.messageDeleted = !!(del && del.ok);
    if (!out.messageDeleted) {
      out.notes.push('删除频道消息失败：' + ((del && del.description) || '未知原因') +
        '（要删 48 小时以前的消息，bot 需要有删除权限）');
    }
  } else {
    out.notes.push('数据库里没有这条图片的消息记录，只清了数据库与缓存。' +
      '（这条是本次改造之前上传的老图，频道里的消息需要你手动删一下。）');
  }

  // 2) 清数据库
  try {
    const url = dbUrlOf(fileId);
    const r1 = await db.prepare('DELETE FROM imginfo WHERE url = ?').bind(url).run();
    const r2 = await db.prepare('DELETE FROM tgimglog WHERE url = ?').bind(url).run();
    await db.prepare('DELETE FROM tgmsg WHERE file_id = ?').bind(fileId).run();
    out.dbRowsRemoved = ((r1 && r1.meta && r1.meta.changes) || 0) + ((r2 && r2.meta && r2.meta.changes) || 0);
  } catch (e) {
    out.notes.push('清数据库失败：' + (e && e.message));
  }

  // 3) 清边缘缓存（否则最长 7 天内还能打开）
  try {
    const purge = await purgeFileCache(origin, fileId, null, cachesImpl);
    out.cachePurged = (purge.purged || []).filter(p => p.ok).length;
    if (!purge.supported) out.notes.push('当前环境不支持清缓存，可能需要到 Cloudflare 后台 Purge。');
  } catch (e) {
    out.notes.push('清缓存失败：' + (e && e.message));
  }

  return out;
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export async function statsOverview({ db, origin }) {
  const totalRow = await db.prepare(
    'SELECT COUNT(*) AS images, COALESCE(SUM(total), 0) AS views FROM imginfo'
  ).first();
  const top = (await db.prepare(
    'SELECT url, total FROM imginfo ORDER BY total DESC, id DESC LIMIT 10'
  ).all()).results || [];
  const refs = (await db.prepare(
    'SELECT referer, COUNT(*) AS c FROM tgimglog GROUP BY referer ORDER BY c DESC LIMIT 10'
  ).all()).results || [];
  const logRow = await db.prepare('SELECT COUNT(*) AS c FROM tgimglog').first();

  return {
    images: (totalRow && totalRow.images) || 0,
    views: (totalRow && totalRow.views) || 0,
    logRows: (logRow && logRow.c) || 0,
    top,
    refs,
    origin
  };
}

export async function statsOne({ db, fileId, origin }) {
  const url = dbUrlOf(fileId);
  const info = await db.prepare(
    'SELECT url, referer, ip, rating, total, time FROM imginfo WHERE url = ?'
  ).bind(url).first();
  const hits = await db.prepare(
    'SELECT COUNT(*) AS c FROM tgimglog WHERE url = ?'
  ).bind(url).first();
  const refs = (await db.prepare(
    'SELECT referer, COUNT(*) AS c FROM tgimglog WHERE url = ? GROUP BY referer ORDER BY c DESC LIMIT 5'
  ).bind(url).all()).results || [];

  return {
    fileId,
    found: !!info,
    info: info || null,
    hits: (hits && hits.c) || 0,
    refs,
    link: `${origin}/i/${fileId}`
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export async function exportList({ db, tg, origin, chatId }) {
  const rows = (await db.prepare(
    'SELECT id, url, referer, rating, total, time FROM imginfo ORDER BY id ASC'
  ).all()).results || [];

  const table = [['序号', 'file_id', '绝对链接', '引用来源', '访问次数', '鉴黄等级', '上传时间']];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ref = parseFileRef(r.url || '');
    table.push([
      i + 1,
      ref.fileId,
      `${origin}/i/${ref.fileId}${ref.ext ? '.' + ref.ext : ''}`,
      r.referer,
      r.total,
      r.rating,
      r.time
    ]);
  }

  // 加 BOM，Excel 打开才不会乱码
  const csv = '\ufeff' + toCsv(table);
  const fileName = `图床链接清单-${shanghaiDate()}.csv`;

  let sent = null;
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([csv], { type: 'text/csv' }), fileName);
    form.append('caption', `共 ${rows.length} 条记录。这份清单能在最坏情况下告诉你丢了什么，建议存一份到网盘。`);
    sent = await tg.callForm('sendDocument', form);
  } catch (e) {
    return { ok: false, count: rows.length, error: (e && e.message) || '发送失败' };
  }

  return {
    ok: !!(sent && sent.ok),
    count: rows.length,
    fileName,
    bytes: csv.length,
    error: sent && sent.ok ? null : ((sent && sent.description) || '发送失败')
  };
}

// ---------------------------------------------------------------------------
// 同步（把最近频道消息补进数据库）
// ---------------------------------------------------------------------------

async function restoreWebhook({ env, tg, origin, db }) {
  let url = await getState(db, 'webhook_url');
  if (!url) url = `${origin}/api/tgbot`;
  const payload = { url, allowed_updates: ['message', 'channel_post'] };
  if (env.TG_WEBHOOK_SECRET) payload.secret_token = env.TG_WEBHOOK_SECRET;
  return tg.call('setWebhook', payload);
}

/**
 * ⚠️ 说清楚能力边界：Telegram Bot API **没有**"列出频道历史消息"的接口，
 *    能拿到的只有 getUpdates 里最近 24 小时内的待投递更新。
 *    所以这里只能补最近这一段，不是全量回填。
 *    真正的"以后不再丢"靠的是 webhook 把每条新频道消息都登记进数据库。
 *
 * ⚠️ 两个必须知道的副作用：
 *    1) 为了拿到 getUpdates，必须先把 webhook 撤掉（否则 Telegram 回 409）。
 *       撤下到恢复之间有几秒钟 —— 这几秒内到达的消息会丢。所以别频繁执行。
 *    2) 恢复时优先用"当初 setup 时记下来的那个地址"，而不是当前访问的域名。
 *       这是故意的：万一你在预览域名（xxxx.pages.dev 那种带随机串的地址）上
 *       顺手跑了一次 /sync，也不会把 webhook 指到预览地址上去，
 *       免得生产域名从此收不到新消息。
 */
export async function syncRecent({ env, tg, db, origin }) {
  await ensureSchema(db);
  const out = {
    pulled: 0,
    logged: 0,
    alreadyKnown: 0,
    attempted: 0,
    webhookRestored: false,
    errors: []
  };

  let removed = false;
  try {
    // 撤掉 webhook —— 否则 getUpdates 会返回 409 Conflict
    const del = await tg.call('deleteWebhook', { drop_pending_updates: false });
    removed = !!(del && del.ok);
    if (!removed) out.errors.push('撤下 webhook 失败：' + ((del && del.description) || '未知原因'));

    const ups = await tg.call('getUpdates', { limit: 100, allowed_updates: ['channel_post'] });
    if (!ups || !ups.ok) {
      out.errors.push('getUpdates 失败：' + ((ups && ups.description) || '未知原因'));
    } else {
      for (const u of (ups.result || [])) {
        out.pulled++;
        if (!u.channel_post) continue;
        out.attempted++;
        try {
          const r = await recordChannelPost({ post: u.channel_post, env, db });
          if (r.logged) out.logged++;
          else if (r.reason === 'known') out.alreadyKnown++;
        } catch (e) {
          out.errors.push('处理一条频道消息失败：' + (e && e.message));
        }
      }
    }
  } catch (e) {
    out.errors.push((e && e.message) || '同步异常');
  } finally {
    // ⚠️ 无论如何都要把 webhook 恢复，否则之后的新消息会全部收不到！
    if (removed) {
      try {
        const back = await restoreWebhook({ env, tg, origin, db });
        out.webhookRestored = !!(back && back.ok);
        if (!out.webhookRestored) {
          out.errors.push('webhook 恢复失败！请立刻访问一次 /api/tgbot/setup?key=... 重新注册。');
        }
      } catch (e) {
        out.errors.push('webhook 恢复异常：' + (e && e.message));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 健康巡检
// ---------------------------------------------------------------------------

/**
 * 检查：bot token / 频道可达 / （可选）视频频道 / D1 / 站点本身。
 *
 * 告警时机（既不会漏，也不会刷屏）：
 *   - 状态刚发生变化（好→坏 / 坏→好）→ 立刻说一声
 *   - 一直没修好 → 距离上次提醒超过 20 小时才再说一次（约等于每天敲一次）
 * 这样即便有人把定时器改成每小时跑，也不会变成每小时轰炸。
 */
export async function runHealthCheck({ env, tg, db, origin, fetchImpl = fetch, notify = true, now = new Date() }) {
  const checks = [];

  try {
    const me = await tg.call('getMe', {});
    checks.push({
      name: 'Bot Token',
      ok: !!(me && me.ok),
      // bot 的 username 是可选的，没设的话别显示成 "@undefined"
      detail: me && me.ok
        ? ('@' + ((me.result && me.result.username) || '未设置用户名'))
        : ((me && me.description) || '调用失败')
    });
  } catch (e) {
    checks.push({ name: 'Bot Token', ok: false, detail: (e && e.message) || '异常' });
  }

  try {
    const chat = await tg.call('getChat', { chat_id: env.TG_CHAT_ID });
    checks.push({
      name: '存储频道可达',
      ok: !!(chat && chat.ok),
      detail: chat && chat.ok
        ? (chat.result.title || (chat.result.id != null ? String(chat.result.id) : '未知频道'))
        : ((chat && chat.description) || '调用失败')
    });
  } catch (e) {
    checks.push({ name: '存储频道可达', ok: false, detail: (e && e.message) || '异常' });
  }

  if (env.TG_CHAT_ID_VIDEO && String(env.TG_CHAT_ID_VIDEO) !== String(env.TG_CHAT_ID)) {
    try {
      const chat2 = await tg.call('getChat', { chat_id: env.TG_CHAT_ID_VIDEO });
      checks.push({
        name: '视频分流频道可达',
        ok: !!(chat2 && chat2.ok),
        detail: chat2 && chat2.ok
          ? (chat2.result.title || (chat2.result.id != null ? String(chat2.result.id) : '未知频道'))
          : ((chat2 && chat2.description) || '调用失败')
      });
    } catch (e) {
      checks.push({ name: '视频分流频道可达', ok: false, detail: (e && e.message) || '异常' });
    }
  }

  try {
    const r = db ? await db.prepare('SELECT 1 AS ok').first() : null;
    checks.push({ name: 'D1 数据库', ok: !!r, detail: r ? '可读写' : '未绑定' });
  } catch (e) {
    checks.push({ name: 'D1 数据库', ok: false, detail: (e && e.message) || '异常' });
  }

  try {
    const res = await fetchImpl(`${origin}/api/total`, { headers: { 'User-Agent': UA } });
    checks.push({ name: '站点本身', ok: !!res.ok, detail: 'HTTP ' + res.status });
  } catch (e) {
    checks.push({ name: '站点本身', ok: false, detail: (e && e.message) || '请求失败' });
  }

  const failed = checks.filter(c => !c.ok);
  const overall = failed.length ? 'fail' : 'ok';

  let changed = false;
  if (db) {
    const prev = await getState(db, 'health_status');
    changed = prev !== overall;
    if (changed) await setState(db, 'health_status', overall);
  }

  // 决定这次要不要发消息（理由见函数上方的注释）
  let shouldNotify = false;
  if (changed) {
    shouldNotify = true;
  } else if (failed.length) {
    const last = db ? await getState(db, 'health_notified_at') : null;
    const lastTs = last ? Date.parse(last) : NaN;
    const elapsedHours = isFinite(lastTs) ? (now.getTime() - lastTs) / 3600000 : Infinity;
    shouldNotify = elapsedHours >= 20;
  }

  if (notify && env.TG_ADMIN_ID && shouldNotify) {
    const lines = [
      failed.length ? '🚨 <b>图床体检发现问题</b>' : '✅ <b>图床体检恢复正常</b>',
      '',
      ...checks.map(c => `${c.ok ? '✅' : '❌'} ${escapeHtml(c.name)}：${escapeHtml(c.detail)}`)
    ];
    const sent = await reply(tg, env.TG_ADMIN_ID, lines.join('\n'));
    // 只在"报故障"时记时间。恢复正常那条不记，
    // 这样万一刚恢复又立刻挂了，会因为状态变化立刻再报一次，不会被人为压掉。
    if (db && failed.length && sent && sent.ok) {
      await setState(db, 'health_notified_at', now.toISOString());
    }
  }

  return { overall, checks, changed, failedCount: failed.length, notified: shouldNotify };
}

// ---------------------------------------------------------------------------
// 每日播报
// ---------------------------------------------------------------------------

export async function buildDailyReport({ env, db, origin }) {
  await ensureSchema(db);
  const lastRaw = await getState(db, 'last_broadcast_id');
  const lastId = lastRaw ? (parseInt(lastRaw, 10) || 0) : 0;

  const totalRow = await db.prepare(
    'SELECT COUNT(*) AS images, COALESCE(SUM(total), 0) AS views, COALESCE(MAX(id), 0) AS maxId FROM imginfo'
  ).first();
  const newRow = await db.prepare('SELECT COUNT(*) AS c FROM imginfo WHERE id > ?').bind(lastId).first();
  const latest = (await db.prepare(
    'SELECT url, time FROM imginfo WHERE id > ? ORDER BY id DESC LIMIT 5'
  ).bind(lastId).all()).results || [];
  const top = (await db.prepare(
    'SELECT url, total FROM imginfo ORDER BY total DESC, id DESC LIMIT 5'
  ).all()).results || [];
  const refs = (await db.prepare(
    'SELECT referer, COUNT(*) AS c FROM tgimglog GROUP BY referer ORDER BY c DESC LIMIT 5'
  ).all()).results || [];

  const images = (totalRow && totalRow.images) || 0;
  const views = (totalRow && totalRow.views) || 0;
  const maxId = (totalRow && totalRow.maxId) || 0;
  const newCount = (newRow && newRow.c) || 0;

  const link = (u) => {
    const ref = parseFileRef(u || '');
    return `${origin}/i/${ref.fileId}`;
  };

  const lines = [
    '📊 <b>图床日报</b>',
    '',
    `累计图片：<b>${images}</b> 张`,
    `累计访问：<b>${views}</b> 次`,
    `上次播报之后新增：<b>${newCount}</b> 张`
  ];

  if (latest.length) {
    lines.push('', '🆕 <b>最近新增</b>');
    for (const r of latest) lines.push(`• ${escapeHtml(r.time || '')}　${escapeHtml(link(r.url))}`);
  }

  if (top.length) {
    lines.push('', '🔥 <b>访问最多</b>');
    for (const r of top) lines.push(`• ${Number(r.total) || 0} 次　${escapeHtml(link(r.url))}`);
  }

  if (refs.length) {
    lines.push('', '🔗 <b>主要来源</b>');
    for (const r of refs) lines.push(`• ${Number(r.c) || 0} 次　${escapeHtml(r.referer || '(空)')}`);
  }

  lines.push('', `<i>${escapeHtml(origin)}</i>`);

  return { text: lines.join('\n'), maxId, newCount, images, views };
}

// ---------------------------------------------------------------------------
// 一次性设置
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 关于「置顶」：现在只剩 AUTO_UNPIN 一个开关
//
// 背景（很重要，否则会一直以为是自己代码的问题）：
// Telegram 官方行为 —— 频道绑定讨论组之后，
//   「New posts from the channel will be automatically forwarded to the group
//     and pinned there.」
// 也就是：**频道每发一条新消息，Telegram 都会自动往讨论组转发一份并把它置顶**。
// 图片一张张传进去，讨论组的置顶区就会被刷满。Telegram 自己没给关闭开关，
// 所以只能在"收到的瞬间"把它取消掉 —— 这就是 AUTO_UNPIN 存在的唯一原因。
//
// ⚠️ 另一处置顶（/setup 时往存储频道发一条"使用说明"并置顶）**已从代码里彻底删除**。
//    原因见 setupBot() 里那段注释。现在频道里只会出现「你上传的图片」本身。
// ---------------------------------------------------------------------------

function isOffValue(v) {
  return /^(off|false|0|no|disable|disabled)$/i.test(String(v == null ? '' : v).trim());
}

/**
 * AUTO_UNPIN —— 讨论组里的自动取消置顶。三种取值：
 *   不设 / on / true      → 只取消"刚转发进来的那一条"（默认）
 *   all                   → 顺手把该讨论组的置顶**全部**清掉（可用于清理历史积累）
 *   off / false / 0 / no  → 什么都不做，保留 Telegram 的自动置顶
 *
 * 默认开启，因为绑了讨论组的图床频道，置顶区被图片刷满几乎没有意义。
 */
export function autoUnpinMode(env) {
  const v = String((env && env.AUTO_UNPIN) || '').trim().toLowerCase();
  if (isOffValue(v)) return 'off';
  if (v === 'all') return 'all';
  return 'single';
}

export function autoUnpinEnabled(env) {
  return autoUnpinMode(env) !== 'off';
}

export async function setupBot({ env, tg, origin, db }) {
  await ensureSchema(db);
  const steps = [];
  const webhookUrl = `${origin}/api/tgbot`;

  const wh = { url: webhookUrl, allowed_updates: ['message', 'channel_post'] };
  if (env.TG_WEBHOOK_SECRET) wh.secret_token = env.TG_WEBHOOK_SECRET;
  const setWh = await tg.call('setWebhook', wh);
  steps.push({
    step: '注册 webhook（让 bot 能收到命令与频道消息）',
    ok: !!(setWh && setWh.ok),
    detail: (setWh && setWh.ok) ? webhookUrl : ((setWh && setWh.description) || '失败')
  });
  if (setWh && setWh.ok) await setState(db, 'webhook_url', webhookUrl);

  // 清空命令菜单（2026-09-18 业主主动要求，理由见本文件顶部 BOT_COMMANDS 的注释）。
  // 原因：他的群里有别的机器人，一输入 / 就弹出一长串命令，太乱。
  // ⚠️ 命令本身**一个都没删** —— /start /help /stats /del /export /sync /health /id
  //    全部照旧可用，只是在 Telegram 里**不再注册成菜单**，需要时直接在私聊手打。
  // 用 deleteMyCommands 而不是"什么都不做"，是为了把**已经注册过的菜单也清掉**，
  // 并且重复访问 /setup 也会保持"没有菜单"这个状态（幂等）。
  const mc = await tg.call('deleteMyCommands', {});
  steps.push({
    step: '清空 Telegram 命令菜单',
    ok: !!(mc && mc.ok),
    detail: (mc && mc.ok)
      ? `${BOT_COMMANDS.length} 条命令仍可手打使用（私聊发 /help 查看全部）`
      : ((mc && mc.description) || '失败')
  });

  // --- 这里原本会「往频道发一条使用说明 + 置顶」。现已彻底删除（2026-09-18）---
  //
  // 为什么删掉：
  //   1) 频道的定位是「图片存储后端」，**只应该出现用户自己上传的图片**。
  //      一条置顶的说明文字属于噪音；而且它本来也不是必需品 ——
  //      用法随时可以在私聊里发 /help 查（helpText() 就是同一份内容）。
  //   2) 上一版用 PIN_USAGE 变量控制"发不发"。但开关本身就是多余的：
  //      与其让用户多配一个变量、多一个"加了没生效"的坑，不如直接不要这段逻辑。
  //   3) 旧版本已经发出去的那几条说明，**代码回收不了**（当时没记录 message_id），
  //      只能手动删 —— 这更是"索性别再发"的理由。
  //
  // 所以 setupBot() 现在只做两件事：注册 webhook、注册命令菜单。
  // 频道里从此只会出现「上传的图片」本身（以及 Telegram 自己的服务消息，如"某某添加了机器人"）。

  return { origin, webhookUrl, steps };
}

// ---------------------------------------------------------------------------
// 更新分发
// ---------------------------------------------------------------------------

/**
 * 处理一条 Telegram update。
 * 返回一个描述"做了什么"的对象（便于测试与日志）。
 */
export async function handleUpdate({ update, env, tg, db, origin, fetchImpl = fetch, cachesImpl = null }) {
  if (!update || typeof update !== 'object') return { handled: false, reason: 'empty-update' };
  await ensureSchema(db);

  // 频道里新发的消息 → 登记下来（这是"以后不再丢记录"的关键）
  if (update.channel_post) {
    const r = await recordChannelPost({ post: update.channel_post, env, db });
    return Object.assign({ handled: true, kind: 'channel_post' }, r);
  }

  const msg = update.message || update.edited_message;
  if (!msg) return { handled: false, reason: 'unsupported-update' };

  const chatType = (msg.chat && msg.chat.type) || '';

  if (chatType === 'private') {
    return handlePrivateMessage({ msg, env, tg, db, origin, fetchImpl, cachesImpl });
  }

  // 频道新帖被自动转发到绑定的讨论组时，Telegram 会顺手把它**置顶**（官方行为）。
  // 就在它刚到的这一刻取消掉 —— 见文件开头 AUTO_UNPIN 的说明。
  // 这类消息的正文是频道帖的原文，不会是「删除」两个字，所以处理完直接返回即可。
  if (msg.is_automatic_forward) {
    return handleAutoForward({ msg, env, tg });
  }

  // 群/超级群里的 `/id`（2026-09-18 新增）。
  // 只回管理员；用来查"这个群的真实 ID 是多少"，排查「回复删图没反应」时它是决定性的
  // 一步（详见 handleGroupId 的说明）。注意：`/id` 是命令，即使 bot 开着隐私模式、
  // 或者没被设为管理员，命令也能送达 —— 所以"发 /id 有回应"本身就说明"消息能到 bot"。
  if (/^\/id(?:@\S+)?\s*$/i.test(String(msg.text || '').trim())) {
    return handleGroupId({ msg, env, tg });
  }

  // 群/超级群：其余只关心"回复某张图 + 说删除"
  return handleGroupDeleteReply({ msg, env, tg, db, origin, cachesImpl });
}

/**
 * 处理「频道新帖被自动转发到讨论组」的那条消息 —— 顺手取消它的置顶。
 *
 * 存在的唯一原因：这是 Telegram 的官方行为。频道绑了讨论组之后，
 * 频道每发一条新消息，Telegram 都会自动往讨论组转发一份**并把它置顶**
 * （官方原文：New posts from the channel will be automatically forwarded to
 *   the group and pinned there.）。图床每传一张图就置顶一条，置顶区很快被刷满。
 * Telegram 没有给关闭这个行为的开关，只能在"收到的那一刻"取消掉。
 *
 * 前提：bot 得在讨论组里**有权置顶**（通常就是把 bot 设成群管理员并勾选「置顶消息」）。
 */
async function handleAutoForward({ msg, env, tg }) {
  const mode = autoUnpinMode(env);
  if (mode === 'off') {
    return { handled: true, kind: 'auto-forward', unpinned: false, reason: 'auto-unpin-off' };
  }

  const chatId = msg.chat && msg.chat.id;

  if (mode === 'all') {
    const res = await tg.call('unpinAllChatMessages', { chat_id: chatId });
    return {
      handled: true,
      kind: 'auto-forward',
      mode: 'all',
      unpinned: !!(res && res.ok),
      chatId,
      detail: (res && res.ok)
        ? '已清空该讨论组的置顶'
        : ((res && res.description) || '清空置顶失败')
    };
  }

  const res = await tg.call('unpinChatMessage', {
    chat_id: chatId,
    message_id: msg.message_id
  });
  return {
    handled: true,
    kind: 'auto-forward',
    mode: 'single',
    unpinned: !!(res && res.ok),
    chatId,
    messageId: msg.message_id,
    detail: (res && res.ok)
      ? '已取消置顶'
      : (((res && res.description) || '取消置顶失败') +
         ' —— bot 需要在讨论组里有「置顶消息」权限（把 bot 设成群管理员并勾上它）')
  };
}

function idText(msg, env) {
  return [
    '<b>当前会话 ID</b>',
    '',
    `你的用户 ID：<code>${escapeHtml(msg.from && msg.from.id)}</code>`,
    `本会话 chat_id：<code>${escapeHtml(msg.chat && msg.chat.id)}</code>`,
    '',
    '存储频道（已配置）：<code>' + escapeHtml(env.TG_CHAT_ID || '未配置') + '</code>',
    '视频分流频道：<code>' + escapeHtml(env.TG_CHAT_ID_VIDEO || '未配置') + '</code>',
    '',
    '把「你的用户 ID」填到 TG_ADMIN_ID 即可获得管理权限。'
  ].join('\n');
}

async function handlePrivateMessage({ msg, env, tg, db, origin, fetchImpl, cachesImpl }) {
  const text = String(msg.text || '').trim();
  // 命令名允许字母、数字、下划线（Telegram 的官方规则就是这三样）
  const m = /^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return { handled: false, reason: 'not-a-command' };

  const cmd = m[1].toLowerCase();
  const arg = String(m[2] || '').trim();

  // /id 不需要管理员权限 —— 它本来就是用来查配置所需的 ID 的
  if (cmd === 'id') {
    await reply(tg, msg.chat.id, idText(msg, env));
    return { handled: true, cmd };
  }

  // 身份校验：fail closed。没配 TG_ADMIN_ID 就一切管理命令都拒绝。
  if (!env.TG_ADMIN_ID) {
    await reply(tg, msg.chat.id,
      '⚠️ 还没配置 <code>TG_ADMIN_ID</code>，管理命令暂时不可用。\n\n' +
      '先给 bot 发送 /id 查到你的用户 ID，把它填进 Cloudflare 的 <code>TG_ADMIN_ID</code> 变量并重新部署。');
    return { handled: true, cmd, reason: 'no-admin-configured' };
  }
  if (String(msg.from && msg.from.id) !== String(env.TG_ADMIN_ID)) {
    // 刻意不回复，避免向陌生人暴露这个 bot 的用途
    return { handled: true, cmd, reason: 'not-admin' };
  }

  // ⚠️ 以下几个命令全都要读写数据库。
  //    如果没绑 D1（绑定名必须是 IMG）就直接往下走，会在 db.prepare 上抛异常，
  //    异常被后台吞掉 —— 用户那边就是"发了命令，bot 一点反应都没有"。
  //    这是最难自查的一种坏法，所以这里提前挡下来，并告诉他怎么修。
  const NEEDS_DB = ['stats', 'del', 'export', 'sync'];
  if (NEEDS_DB.includes(cmd) && !db) {
    await reply(tg, msg.chat.id,
      '⚠️ 还没绑定 D1 数据库，<code>/' + escapeHtml(cmd) + '</code> 暂时用不了。\n\n' +
      '<b>绑定方法</b>：Cloudflare → 你的 Pages 项目 → 设置 → 函数 → D1 数据库绑定，' +
      '变量名（Variable name）填 <code>IMG</code>，选上你的数据库 → 保存并重新部署。\n\n' +
      '绑好之后 /stats、/del、/export、/sync 就都能用了。');
    return { handled: true, cmd, reason: 'no-db' };
  }

  switch (cmd) {
    case 'start':
    case 'help': {
      await reply(tg, msg.chat.id, helpText(origin));
      return { handled: true, cmd };
    }
    case 'ping': {
      await reply(tg, msg.chat.id, 'pong');
      return { handled: true, cmd };
    }
    case 'stats': {
      if (arg) {
        const { fileId } = parseFileRef(arg);
        if (!fileId) {
          await reply(tg, msg.chat.id, '没看懂这个链接，试试直接发 /stats 后面跟图片链接。');
          return { handled: true, cmd, reason: 'bad-ref' };
        }
        const s = await statsOne({ db, fileId, origin });
        if (!s.found) {
          await reply(tg, msg.chat.id,
            `数据库里没有 <code>${escapeHtml(fileId)}</code> 的记录。\n` +
            `可能是本次改造之前上传的老图（那时没有记录）。\n\n链接：${escapeHtml(s.link)}`);
          return { handled: true, cmd, reason: 'not-found' };
        }
        const topRefs = s.refs.map(r => `　• ${Number(r.c) || 0} 次　${escapeHtml(r.referer || '(空)')}`).join('\n');
        await reply(tg, msg.chat.id, [
          '🔎 <b>单张图片统计</b>',
          '',
          `链接：${escapeHtml(s.link)}`,
          `访问次数（imginfo）：<b>${Number(s.info.total) || 0}</b>`,
          `日志条数（tgimglog）：<b>${Number(s.hits) || 0}</b>`,
          `鉴黄等级：${s.info.rating == null ? '未检测' : s.info.rating}`,
          `上传时间：${escapeHtml(s.info.time || '')}`,
          topRefs ? '\n来源：\n' + topRefs : ''
        ].join('\n'));
        return { handled: true, cmd };
      }
      const o = await statsOverview({ db, origin });
      const topLines = o.top.map(r => {
        const ref = parseFileRef(r.url || '');
        return `　• ${Number(r.total) || 0} 次　${escapeHtml(origin)}/i/${escapeHtml(ref.fileId)}`;
      }).join('\n');
      const refLines = o.refs.map(r => `　• ${Number(r.c) || 0} 次　${escapeHtml(r.referer || '(空)')}`).join('\n');
      await reply(tg, msg.chat.id, [
        '📊 <b>总体统计</b>',
        '',
        `图片总数：<b>${Number(o.images) || 0}</b>`,
        `累计访问：<b>${Number(o.views) || 0}</b>`,
        `访问日志：<b>${Number(o.logRows) || 0}</b> 条`,
        topLines ? '\n🔥 <b>访问最多</b>\n' + topLines : '',
        refLines ? '\n🔗 <b>主要来源</b>\n' + refLines : ''
      ].join('\n'));
      return { handled: true, cmd };
    }
    case 'del': {
      if (!arg) {
        await reply(tg, msg.chat.id, '用法：<code>/del https://你的域名/i/xxxx.jpg</code>\n也可以只发 file_id。');
        return { handled: true, cmd, reason: 'no-arg' };
      }
      const { fileId } = parseFileRef(arg);
      if (!fileId) {
        await reply(tg, msg.chat.id, '没看懂这个链接，试试直接发图片链接。');
        return { handled: true, cmd, reason: 'bad-ref' };
      }
      const r = await deleteImage({ fileId, env, tg, db, origin, cachesImpl });
      const lines = [
        '🗑 <b>下架结果</b>',
        '',
        `file_id：<code>${escapeHtml(fileId)}</code>`,
        `${r.messageDeleted ? '✅' : '⚠️'} 频道消息：${r.messageDeleted ? '已删除' : '未删除'}`,
        `✅ 数据库清理：${r.dbRowsRemoved} 行`,
        `✅ 缓存清理：${r.cachePurged} 条`
      ];
      if (r.notes.length) lines.push('', '注意：', ...r.notes.map(n => '　• ' + escapeHtml(n)));
      await reply(tg, msg.chat.id, lines.join('\n'));
      return { handled: true, cmd, result: r };
    }
    case 'export': {
      await reply(tg, msg.chat.id, '⏳ 正在生成清单…');
      const r = await exportList({ db, tg, origin, chatId: msg.chat.id });
      if (!r.ok) {
        await reply(tg, msg.chat.id, '❌ 导出失败：' + escapeHtml(r.error || '未知原因'));
      }
      return { handled: true, cmd, result: r };
    }
    case 'sync': {
      await reply(tg, msg.chat.id, '⏳ 正在同步，期间 bot 会短暂断开几秒…');
      const r = await syncRecent({ env, tg, db, origin });
      const lines = [
        '🔄 <b>同步结果</b>',
        '',
        `拉取到的更新：${r.pulled} 条`,
        `其中频道消息：${r.attempted} 条`,
        `新补进数据库：<b>${r.logged}</b> 张`,
        `本来就有记录：${r.alreadyKnown} 张`,
        `${r.webhookRestored ? '✅' : '❌'} webhook 已恢复：${r.webhookRestored ? '是' : '否'}`
      ];
      lines.push('', '<i>说明：Telegram 只保留最近 24 小时的待投递更新，' +
        '所以这里只能补最近这一段，更早的历史无法通过接口取回。</i>');
      if (r.errors.length) lines.push('', '⚠️ 异常：', ...r.errors.map(e => '　• ' + escapeHtml(e)));
      await reply(tg, msg.chat.id, lines.join('\n'));
      return { handled: true, cmd, result: r };
    }
    case 'health': {
      const r = await runHealthCheck({ env, tg, db, origin, fetchImpl, notify: false });
      await reply(tg, msg.chat.id, [
        r.overall === 'ok' ? '✅ <b>体检全部通过</b>' : '🚨 <b>体检发现问题</b>',
        '',
        ...r.checks.map(c => `${c.ok ? '✅' : '❌'} ${escapeHtml(c.name)}：${escapeHtml(c.detail)}`)
      ].join('\n'));
      return { handled: true, cmd, result: r };
    }
    default: {
      await reply(tg, msg.chat.id, `不认识的命令：<code>/${escapeHtml(cmd)}</code>\n发送 /help 看可用命令。`);
      return { handled: true, cmd, reason: 'unknown-command' };
    }
  }
}

/**
 * 从一条"回复"里找出它对应的是频道里的哪条消息。
 * 依赖 Telegram 的 forward_origin（新）或 forward_from_chat（旧）字段。
 */
export function resolveChannelTarget(msg, env) {
  const known = [env.TG_CHAT_ID, env.TG_CHAT_ID_VIDEO]
    .filter(Boolean).map(String);
  if (!known.length) return null;

  const candidates = [];
  if (msg.reply_to_message) candidates.push(msg.reply_to_message);
  candidates.push(msg);

  for (const c of candidates) {
    if (!c) continue;
    if (c.forward_origin && c.forward_origin.type === 'channel' && c.forward_origin.chat) {
      const cid = String(c.forward_origin.chat.id);
      if (known.includes(cid)) {
        return { chat_id: cid, message_id: c.forward_origin.message_id };
      }
    }
    if (c.forward_from_chat && c.forward_from_message_id) {
      const cid = String(c.forward_from_chat.id);
      if (known.includes(cid)) {
        return { chat_id: cid, message_id: c.forward_from_message_id };
      }
    }
  }
  return null;
}

/**
 * 查一个群/频道的基本信息（只要标题）。用于"配置对不上"时给出人能看懂的对照。
 * 查不到就把 Telegram 的原话带回来 —— 那本身就说明"这个 ID 是错的"。
 */
async function chatInfo(tg, id) {
  try {
    const r = await tg.call('getChat', { chat_id: String(id) });
    if (r && r.ok && r.result) {
      return { ok: true, title: r.result.title || r.result.first_name || '（无标题）' };
    }
    return { ok: false, title: '⚠️ 取不到（' + ((r && r.description) || '未知错误') + '）' };
  } catch (e) {
    return { ok: false, title: '⚠️ 取不到（' + ((e && e.message) || '请求异常') + '）' };
  }
}

/**
 * 群里的 `/id`（2026-09-18 新增）。
 *
 * 以前 `/id` 只在私聊有效、群里是**静默无响应**的。但排查「回复删图不生效」时，
 * 第一步要确认的恰恰是"这个群的真实 ID 和后台 TG_GROUP_ID 是否一致" ——
 * 没有它，业主只能自己去翻消息链接、手算 `-100` 前缀，门槛太高。
 * 所以现在群里也认 `/id`，但**只回管理员**（其他人一律不回复，不暴露 bot）。
 */
async function handleGroupId({ msg, env, tg }) {
  const chatId = String((msg.chat && msg.chat.id) || '');
  const fromId = String((msg.from && msg.from.id) || '');
  const adminId = env.TG_ADMIN_ID ? String(env.TG_ADMIN_ID) : '';
  if (!adminId || fromId !== adminId) {
    return { handled: true, cmd: 'id', reason: 'not-admin' };
  }

  const here = await chatInfo(tg, chatId);
  const conf = env.TG_GROUP_ID ? await chatInfo(tg, String(env.TG_GROUP_ID)) : null;
  const same = !!env.TG_GROUP_ID && String(env.TG_GROUP_ID) === chatId;

  await reply(tg, chatId, [
    '<b>本群信息</b>',
    '',
    '群名：<b>' + escapeHtml(here.title) + '</b>',
    '群 ID：<code>' + escapeHtml(chatId) + '</code>',
    '',
    '<b>对照后台配置</b>',
    '· <code>TG_GROUP_ID</code>：' + (env.TG_GROUP_ID
      ? '<code>' + escapeHtml(String(env.TG_GROUP_ID)) + '</code>（' + escapeHtml(conf.title) + '）'
        + (same ? ' ✅ <b>一致</b>' : ' ❌ <b>不一致 —— 「回复删图」会因此完全没反应</b>')
      : '<b>没配</b> ❌'),
    '· <code>TG_ADMIN_ID</code>：' + (adminId
      ? '<code>' + escapeHtml(adminId) + '</code> ✅（与你的用户 ID 一致）'
      : '<b>没配</b> ❌'),
    '',
    '你的用户 ID：<code>' + escapeHtml(fromId) + '</code>'
  ].join('\n'));
  return { handled: true, cmd: 'id', group: true, sameGroup: !!same, chatId };
}

/**
 * 频道讨论组里「回复某张图 + 发送删除」的流程。
 *
 * 安全上做了三重收紧，缺一不可：
 *   1) 必须配置了 TG_ADMIN_ID 与 TG_GROUP_ID（否则整个流程关闭）
 *   2) 消息必须来自指定的那个讨论组（防止有人把 bot 拉进自己的群，
 *      回复一张转发来的图，就能删掉你频道里的内容）
 *   3) 发送者必须是管理员本人
 *
 * ⚠️ 2026-09-18 修的 bug（业主反馈「上个版本还能删，更新后在群里发删除 bot 完全没反应」）：
 *    上面这三重锁在**不满足时是静默 return 的**。对陌生人保持沉默是对的
 *    （不暴露 bot 的存在），但对**业主自己**就变成了最糟的体验：面板不报错、
 *    日志要现开、他只能看到"没反应"，无从自查 —— 而实测最可能的原因就是
 *    `TG_GROUP_ID` 和真实的群对不上（群里那份还被填成了「文本」类型）。
 *    现在改成：**只要确认发消息的人就是管理员本人**，就把"为什么没执行"
 *    连同两个群的 ID 与名称一起回给他。对其他人仍然一个字都不回。
 *    判据：adminId 非空、且 msg.from.id === adminId（拿不到 adminId 就一律沉默）。
 */
async function handleGroupDeleteReply({ msg, env, tg, db, origin, cachesImpl }) {
  const text = String(msg.text || '').trim();
  const isDeleteWord = /(删除|下架)/.test(text) || /^(delete|del|remove)\b/i.test(text);
  if (!isDeleteWord) return { handled: false, reason: 'not-delete-keyword' };

  const chatId = String((msg.chat && msg.chat.id) || '');
  const fromId = String((msg.from && msg.from.id) || '');
  const adminId = env.TG_ADMIN_ID ? String(env.TG_ADMIN_ID) : '';
  const isAdmin = !!adminId && fromId === adminId;

  // ---- ① 配置不完整 ----
  if (!adminId || !env.TG_GROUP_ID) {
    if (isAdmin) {
      const miss = [];
      if (!adminId) miss.push('TG_ADMIN_ID');
      if (!env.TG_GROUP_ID) miss.push('TG_GROUP_ID');
      await reply(tg, chatId,
        '⚠️ 「回复删图」暂时用不了 —— 后台少配了 '
        + miss.map((m) => '<code>' + m + '</code>').join(' / ') + '。\n\n'
        + '到 Cloudflare → 你的 Pages 项目 → Settings → Variables and Secrets 补上（类型选「机密」），'
        + '然后重新部署一次即可。');
      return { handled: true, reason: 'not-configured', notified: true };
    }
    return { handled: false, reason: 'not-configured' };
  }

  // ---- ② 这条消息不是来自配置的那个讨论组 ----
  if (chatId !== String(env.TG_GROUP_ID)) {
    if (isAdmin) {
      // 顺手把两边都查出来，直接指出"到底哪里对不上" —— 这是最难自查的一种坏法
      const here = await chatInfo(tg, chatId);
      const conf = await chatInfo(tg, String(env.TG_GROUP_ID));
      await reply(tg, chatId, [
        '⚠️ 我<b>没有执行</b>删除，因为这条消息来自的群，和后台配置的那个群对不上：',
        '',
        '· 你现在这个群：<b>' + escapeHtml(here.title) + '</b>',
        '　ID <code>' + escapeHtml(chatId) + '</code>',
        '· 后台 <code>TG_GROUP_ID</code> 配的是：<b>' + escapeHtml(conf.title) + '</b>',
        '　ID <code>' + escapeHtml(String(env.TG_GROUP_ID)) + '</code>',
        '',
        '如果你就是要在<b>这个群</b>里用「回复删图」，'
        + '把 <code>TG_GROUP_ID</code> 改成 <code>' + escapeHtml(chatId) + '</code>'
        + '（类型选「机密」），然后重新部署。',
        '',
        '<i>（这条提示只发给管理员本人；别人发同样的词我一个字都不会回。）</i>'
      ].join('\n'));
      return { handled: true, reason: 'other-chat', notified: true };
    }
    return { handled: false, reason: 'other-chat' };
  }

  // ---- ③ 不是管理员本人：保持沉默（原设计，不向陌生人暴露这个 bot）----
  if (!isAdmin) return { handled: false, reason: 'not-admin' };

  const target = resolveChannelTarget(msg, env);
  if (!target) {
    await reply(tg, msg.chat.id,
      '⚠️ 消息我收到了，但<b>没找到它回复的那张频道图</b>。\n\n'
      + '正确姿势：在讨论组里<b>长按那张自动转发过来的图 → 回复 → 发送「删除」</b>。\n'
      + '<i>（只是单独发一句「删除」、或者回复了一条普通消息，都会看到这条提示。）</i>');
    return { handled: true, reason: 'no-target' };
  }

  const del = await tg.call('deleteMessage', {
    chat_id: target.chat_id,
    message_id: target.message_id
  });
  const deleted = !!(del && del.ok);

  // 顺带清数据库与缓存
  let cleaned = null;
  try {
    const row = await db.prepare(
      'SELECT file_id FROM tgmsg WHERE chat_id = ? AND message_id = ?'
    ).bind(String(target.chat_id), target.message_id).first();

    if (row && row.file_id) {
      const purged = await purgeFileCache(origin, row.file_id, null, cachesImpl);
      await db.prepare('DELETE FROM imginfo WHERE url = ?').bind(dbUrlOf(row.file_id)).run();
      await db.prepare('DELETE FROM tgimglog WHERE url = ?').bind(dbUrlOf(row.file_id)).run();
      await db.prepare('DELETE FROM tgmsg WHERE file_id = ?').bind(row.file_id).run();
      cleaned = {
        fileId: row.file_id,
        cachePurged: (purged.purged || []).filter(p => p.ok).length
      };
    }
  } catch (e) {
    cleaned = { error: (e && e.message) || '清理失败' };
  }

  await reply(tg, msg.chat.id, deleted
    ? `🗑 已下架${cleaned && cleaned.fileId ? '（file_id: <code>' + escapeHtml(cleaned.fileId) + '</code>）' : ''}，数据库与缓存也一并清理了。`
    : ('❌ 删除失败：' + escapeHtml((del && del.description) || '未知原因') +
      '\n<i>提示：bot 需要频道里的「删除消息」权限；且只能删 48 小时以内的消息。</i>'));

  return {
    handled: true,
    kind: 'group-delete',
    target,
    deleted,
    cleaned
  };
}

// 供其它模块复用的常量（避免各自再定义一份）
export { MAX_PHOTO_BYTES, MAX_OTHER_BYTES, mimeToExt };
