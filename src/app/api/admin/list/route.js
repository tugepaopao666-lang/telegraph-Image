// ============================================================================
// src/app/api/admin/list/route.js
//
// 后台列表页要数据时打这里（POST），前端传 { page, query, sort, dir }。
//
// ⚠️ 2026-09-19 改动：
//   ① **参数化**：原来搜索是用 `url LIKE '%${query}%'` 把前端字符串直接拼进 SQL ——
//      既不能正确处理引号（搜 "a'b" 直接报错），也是一个注入面。现在改成 `?` 绑定。
//   ② **支持排序**：新增 sort / dir 两个参数。列名走白名单，永远不可能拼进奇怪的 SQL。
//      前端"排序"下拉框用它。
//   ③ `time` 列**不能**用来排序：它存的是「2026年9月18日 11:30:00」这种中文本地化串，
//      字典序 ≠ 时间序（这是本项目的一条老约定）。所以按时间排一律换算成自增 id。
//
// 返回结构保持原样（前端没改）：{ code, success, message, data, page, total }
// ============================================================================

import { getRequestContext } from '@cloudflare/next-on-pages';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400', // 24 hours
  'Content-Type': 'application/json'
};

export const runtime = 'edge';

const PAGE_SIZE = 10;

/**
 * 排序白名单：只允许这几列，别的输入一律退回默认值。
 * 注意 id 是自增主键 ⇒ "按时间排序"就用它（time 列存的是中文本地化串，排不了）。
 */
const SORTABLE = {
  id: 'id',
  time: 'id',
  total: 'total',
  rating: 'rating',
  referer: 'referer',
  ip: 'ip',
  url: 'url'
};

function orderClause(sort, dir) {
  const col = SORTABLE[String(sort == null ? '' : sort)] || 'id';
  const desc = String(dir == null ? '' : dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return 'ORDER BY ' + col + ' ' + desc + ', id DESC'; // 加 id 兜底，保证稳定分页
}

export async function POST(request) {
  const { env } = getRequestContext();

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }

  try {
    if (!env.IMG) {
      return Response.json({
        code: 500,
        success: false,
        message: '没有绑定 D1 数据库（绑定名必须是 IMG）',
        data: []
      }, { status: 500, headers: corsHeaders });
    }

    const page = Math.max(0, parseInt((body && body.page) || 0, 10) || 0);
    const q = String((body && body.query) || '').trim();
    const order = orderClause(body && body.sort, body && body.dir);

    const where = q ? 'WHERE url LIKE ?' : '';
    const searchBinds = q ? ['%' + q + '%'] : [];

    const ps = env.IMG.prepare(
      'SELECT * FROM imginfo ' + where + ' ' + order + ' LIMIT ? OFFSET ?'
    ).bind.apply(null, searchBinds.concat([PAGE_SIZE, page * PAGE_SIZE]));
    const { results } = await ps.all();

    const totalRow = await env.IMG.prepare(
      'SELECT COUNT(*) as total FROM imginfo ' + where
    ).bind.apply(null, searchBinds).first();

    return Response.json({
      code: 200,
      success: true,
      message: 'success',
      data: results,
      page: page,
      total: (totalRow && totalRow.total) || 0
    }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({
      code: 500,
      success: false,
      message: (error && error.message) || '查询失败',
      data: []
    }, { status: 500, headers: corsHeaders });
  }
}
