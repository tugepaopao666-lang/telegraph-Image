// ============================================================================
// src/app/api/tgbot/setup/route.js
//
// 一次性设置入口。在浏览器里访问一次即可：
//   https://你的域名/api/tgbot/setup?key=<BOT_KEY>
//
// 它会做三件事：
//   1) setWebhook    —— 让 bot 能收到命令和频道消息（不注册就什么都不会发生）
//   2) setMyCommands —— 注册命令菜单（在私聊里输入 / 能看到列表）
//   3) 在频道里发一条使用说明并置顶
//
// 幂等：重复访问不会出问题，只是会再发一条新的置顶说明。
// ============================================================================

import { getRequestContext } from '@cloudflare/next-on-pages';
import { createTg, setupBot, runHealthCheck } from '@/lib/tg-bot';

export const runtime = 'edge';

export async function GET(request) {
  const { env } = getRequestContext();
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!env.BOT_KEY) {
    return Response.json({
      ok: false,
      message: '还没配置 BOT_KEY。请先到 Cloudflare 项目里加一个名为 BOT_KEY 的「机密」变量，再访问这个地址。'
    }, { status: 500 });
  }
  if (key !== env.BOT_KEY) {
    return Response.json({ ok: false, message: 'key 不正确。' }, { status: 403 });
  }
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    return Response.json({
      ok: false,
      message: 'TG_BOT_TOKEN 或 TG_CHAT_ID 没有配置。'
    }, { status: 500 });
  }

  const tg = createTg({ token: env.TG_BOT_TOKEN });

  let result;
  try {
    result = await setupBot({ env, tg, origin: url.origin, db: env.IMG });
  } catch (e) {
    return Response.json({ ok: false, message: (e && e.message) || '设置失败' }, { status: 500 });
  }

  let health = null;
  try {
    health = await runHealthCheck({ env, tg, db: env.IMG, origin: url.origin, notify: false });
  } catch (e) {
    health = { overall: 'fail', checks: [], error: (e && e.message) || '巡检异常' };
  }

  return Response.json({
    ok: result.steps.every(s => s.ok),
    webhookUrl: result.webhookUrl,
    steps: result.steps,
    health
  });
}
