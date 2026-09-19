// ============================================================================
// src/app/api/admin/delete/route.js
//
// 后台列表里那个「删除」按钮打的就是这里。
//
// ⚠️ 2026-09-19 重写。原版只做一件事：
//       DELETE FROM imginfo WHERE url='${name}'
//    —— 也就是说**只删数据库记录，频道里的图还好好躺着**，链接照样能打开。
//    这正是当初要做 bot 的 /del 命令和讨论组「回复删图」的根本原因。
//    现在改成"真删"：
//       ① 按 file_id 查 tgmsg，拿到它在频道里的 message_id
//       ② 调 Telegram deleteMessage 把频道那条消息删掉（图片本体随之消失）
//       ③ 再清数据库（imginfo / tgimglog / tgmsg 三张表）
//       ④ 顺带清边缘缓存（否则最长 7 天内链接还能打开）
//
// 顺带修掉一个安全问题：原来是**把前端传来的字符串直接拼进 SQL**。
//    现在全部改成参数绑定（`?`），并且排序/列名走白名单。
//
// 支持两种调用（兼容老前端）：
//   { name:  '/cfile/xxx' }            → 删一条
//   { names: ['/cfile/a', '/cfile/b'] } → 批量删（后台新增的"批量删除"用它）
//
// 返回里带明细：删了几条频道消息、清了几行库、清了几条缓存 —— 前端会把它们
// 显示在提示里，这样"删了但链接还能打开"这种情况你一眼能看出是缓存没清掉。
// ============================================================================

import { getRequestContext } from '@cloudflare/next-on-pages';
import { createTg, ensureSchema } from '@/lib/tg-bot';
import { purgeFileCache } from '@/lib/tg-serve';
import { parseFileRef } from '@/lib/tg-common';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400', // 24 hours
  'Content-Type': 'application/json'
};

export const runtime = 'edge';

/** 删一条：频道消息 + 数据库 + 缓存。任何一步失败都不影响其它步骤，问题记在 notes 里。 */
async function deleteOne({ env, tg, origin, name }) {
  const out = {
    name,
    fileId: null,
    messageDeleted: false,
    dbRows: 0,
    cachePurged: 0,
    notes: []
  };

  const { fileId } = parseFileRef(String(name == null ? '' : name));
  if (!fileId) {
    out.notes.push('这一条不是 file_id，跳过了（没动数据库）');
    return out;
  }
  out.fileId = fileId;
  const url = `/cfile/${fileId}`;

  await ensureSchema(env.IMG);

  // ---- ① 先把频道里那条消息删掉（这才是"图没了"的关键）----
  if (tg && env.TG_CHAT_ID) {
    try {
      const row = await env.IMG.prepare(
        'SELECT chat_id, message_id FROM tgmsg WHERE file_id = ?'
      ).bind(fileId).first();
      if (row && row.message_id) {
        const del = await tg.call('deleteMessage', {
          chat_id: String(row.chat_id),
          message_id: row.message_id
        });
        out.messageDeleted = !!(del && del.ok);
        if (!out.messageDeleted) {
          out.notes.push('删频道消息失败：' + ((del && del.description) || '未知原因')
            + '（要删 48 小时以前的消息，bot 需要有删除权限）');
        }
      } else {
        out.notes.push('数据库里没有这张图的频道消息记录（多是早先改造前上传的老图），'
          + '频道里那条需要你手动删一下。');
      }
    } catch (e) {
      out.notes.push('删频道消息异常：' + ((e && e.message) || e));
    }
  } else {
    out.notes.push('没配 TG_BOT_TOKEN / TG_CHAT_ID，所以只删了数据库 —— 频道里的图还在。');
  }

  // ---- ② 清数据库（三张表都清，参数绑定）----
  try {
    const r1 = await env.IMG.prepare('DELETE FROM imginfo WHERE url = ?').bind(url).run();
    const r2 = await env.IMG.prepare('DELETE FROM tgimglog WHERE url = ?').bind(url).run();
    await env.IMG.prepare('DELETE FROM tgmsg WHERE file_id = ?').bind(fileId).run();
    out.dbRows = ((r1 && r1.meta && r1.meta.changes) || 0)
      + ((r2 && r2.meta && r2.meta.changes) || 0);
  } catch (e) {
    out.notes.push('清数据库失败：' + ((e && e.message) || e));
  }

  // ---- ③ 清边缘缓存（尽力而为）----
  try {
    const purge = await purgeFileCache(origin, fileId, null, null);
    out.cachePurged = (purge.purged || []).filter((p) => p.ok).length;
    if (!purge.supported) {
      out.notes.push('当前环境不支持清缓存 —— 链接最长 7 天后才会彻底打不开。');
    }
  } catch (e) {
    out.notes.push('清缓存失败：' + ((e && e.message) || e));
  }

  return out;
}

export async function DELETE(request) {
  const { env } = getRequestContext();

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }

  const names = Array.isArray(body && body.names)
    ? body.names
    : (body && body.name ? [body.name] : []);

  if (!names.length) {
    return Response.json({
      code: 400,
      success: false,
      message: '没有收到要删除的条目'
    }, { status: 400, headers: corsHeaders });
  }

  if (!env.IMG) {
    return Response.json({
      code: 500,
      success: false,
      message: '没有绑定 D1 数据库（绑定名必须是 IMG）'
    }, { status: 500, headers: corsHeaders });
  }

  try {
    const tg = env.TG_BOT_TOKEN ? createTg({ token: env.TG_BOT_TOKEN }) : null;
    const origin = new URL(request.url).origin;

    const results = [];
    for (const n of names) {
      try {
        results.push(await deleteOne({ env, tg, origin, name: n }));
      } catch (e) {
        results.push({ name: n, error: (e && e.message) || '异常' });
      }
    }

    const messageDeleted = results.filter((r) => r.messageDeleted).length;
    const dbRows = results.reduce((a, r) => a + (r.dbRows || 0), 0);
    const cachePurged = results.reduce((a, r) => a + (r.cachePurged || 0), 0);
    const notes = [];
    for (const r of results) {
      for (const n of (r.notes || [])) {
        notes.push(r.fileId ? (r.fileId + '：' + n) : n);
      }
    }

    return Response.json({
      code: 200,
      success: true,
      message: '已处理 ' + results.length + ' 条',
      count: results.length,
      messageDeleted,
      dbRows,
      cachePurged,
      results,
      notes
    }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({
      code: 500,
      success: false,
      message: (error && error.message) || '删除失败'
    }, { status: 500, headers: corsHeaders });
  }
}
