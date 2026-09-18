// ============================================================================
// src/lib/tg-cron.js
// 定时任务：健康巡检 + 每日播报。
//
// ⚠️ 为什么需要一个单独的 Cloudflare Worker：
//    Cloudflare **Pages 不支持定时触发（Cron Triggers）**，只有 Workers 支持。
//    所以做法是：建一个极小的 Worker，让它按点去访问
//        https://你的域名/api/cron?key=<BOT_KEY>
//    真正的活儿由本文件在 Pages 这边干。
// ============================================================================

import { createTg, ensureSchema, getState, setState, runHealthCheck, buildDailyReport } from './tg-bot.js';
import { shanghaiDate } from './tg-common.js';

const L = console;

/**
 * @param {object} o
 * @param {object} o.env
 * @param {object} o.db
 * @param {string} o.origin
 * @param {Date}   [o.now]
 * @param {Function} [o.fetchImpl]
 * @param {object} [o.tg]  可注入（测试用）
 */
export async function runCron({ env, db, origin, now = new Date(), fetchImpl = fetch, tg = null }) {
  const t = tg || createTg({ token: env.TG_BOT_TOKEN, fetchImpl });
  const today = shanghaiDate(now);
  const out = { date: today, health: null, broadcast: null, errors: [] };

  if (!db) {
    out.errors.push('D1 未绑定，定时任务全部跳过');
    return out;
  }
  await ensureSchema(db);

  // ---- 1) 健康巡检 --------------------------------------------------------
  // 内部已经做了"只在状态变化、或距上次提醒超过 20 小时时才告警"，
  // 所以就算把定时器跑得比每天更勤，也不会刷屏。
  try {
    out.health = await runHealthCheck({ env, tg: t, db, origin, fetchImpl, notify: true, now });
  } catch (e) {
    out.errors.push('巡检失败：' + ((e && e.message) || e));
  }

  // ---- 2) 每日播报 --------------------------------------------------------
  // 幂等：同一天重复触发只会发一次（cron 服务偶尔重试也不会重复轰炸）。
  try {
    if (!env.TG_ADMIN_ID) {
      out.broadcast = { skipped: true, reason: '没配 TG_ADMIN_ID，不知道发给谁' };
    } else {
      const lastDate = await getState(db, 'last_broadcast_date');
      if (lastDate === today) {
        out.broadcast = { skipped: true, reason: '今天已经播报过了' };
      } else {
        const report = await buildDailyReport({ env, db, origin });
        const sent = await t.call('sendMessage', {
          chat_id: String(env.TG_ADMIN_ID),
          text: report.text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        if (sent && sent.ok) {
          // 先发成功再推进位点 —— 万一发送失败，下次还会重试
          await setState(db, 'last_broadcast_date', today);
          await setState(db, 'last_broadcast_id', report.maxId);
          out.broadcast = {
            sent: true,
            newCount: report.newCount,
            images: report.images,
            views: report.views
          };
        } else {
          out.broadcast = { sent: false, error: (sent && sent.description) || '发送失败' };
          out.errors.push('播报发送失败：' + out.broadcast.error);
        }
      }
    }
  } catch (e) {
    out.errors.push('播报失败：' + ((e && e.message) || e));
  }

  L.log('cron done:', JSON.stringify(out));
  return out;
}
