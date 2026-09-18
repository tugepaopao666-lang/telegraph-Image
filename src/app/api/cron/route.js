// ============================================================================
// src/app/api/cron/route.js
//
// 定时任务入口。由**另一个极小的 Cloudflare Worker** 按点来访问：
//   https://你的域名/api/cron?key=<BOT_KEY>
//
// 为什么不能直接在 Pages 上定时：Cloudflare Pages 不支持 Cron Triggers，
// 只有 Workers 支持。所以定时这件事必须借一个 Worker 的手来触发。
// （Worker 的代码见交付目录里的 cloudflare-cron-worker.js，粘贴到 Cloudflare 即可。）
//
// 这个地址必须用 key 保护 —— 否则任何人都能反复触发播报。
// ============================================================================

import { getRequestContext } from '@cloudflare/next-on-pages';
import { runCron } from '@/lib/tg-cron';

export const runtime = 'edge';

export async function GET(request) {
  const { env } = getRequestContext();
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!env.BOT_KEY) {
    return Response.json({ ok: false, message: '还没配置 BOT_KEY。' }, { status: 500 });
  }
  if (key !== env.BOT_KEY) {
    return Response.json({ ok: false, message: 'key 不正确。' }, { status: 403 });
  }

  try {
    const out = await runCron({ env, db: env.IMG, origin: url.origin });
    return Response.json(Object.assign({ ok: out.errors.length === 0 }, out));
  } catch (e) {
    return Response.json({ ok: false, message: (e && e.message) || '定时任务执行失败' }, { status: 500 });
  }
}

// 方便手动测试：用 POST 也能触发
export async function POST(request) {
  return GET(request);
}
