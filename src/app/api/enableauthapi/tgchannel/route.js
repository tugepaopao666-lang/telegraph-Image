export const runtime = 'edge';
import { getRequestContext } from '@cloudflare/next-on-pages';
import {
	UA,
	MAX_PHOTO_BYTES,
	MAX_OTHER_BYTES,
	humanSize,
	shortLink,
	buildKeyboard,
	buildCaption,
	nowTimeString
} from '@/lib/tg-common';
import { ensureSchema, saveImageInfo } from '@/lib/tg-bot';



const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Max-Age': '86400', // 24 hours
	'Content-Type': 'application/json'
};

export async function POST(request) {
	const { env, cf, ctx } = getRequestContext();

	if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
		return Response.json({
			status: 500,
			message: `TG_BOT_TOKEN or TG_CHAT_ID is not Set`,
			success: false
		}, {
			status: 500,
			headers: corsHeaders,
		})
	}

	const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip');
	const clientIp = ip ? ip.split(',')[0].trim() : 'IP not found';
	const Referer = request.headers.get('Referer') || "Referer";

	const formData = await request.formData();
	const uploadFile = formData.get('file');

	if (!uploadFile || typeof uploadFile === 'string') {
		return Response.json({
			status: 400,
			message: '没有收到要上传的文件',
			success: false
		}, {
			status: 400,
			headers: corsHeaders,
		})
	}

	const fileType = uploadFile.type || 'application/octet-stream';

	const req_url = new URL(request.url);

	const fileTypeMap = {
		'image/': { url: 'sendPhoto', type: 'photo' },
		'video/': { url: 'sendVideo', type: 'video' },
		'audio/': { url: 'sendAudio', type: 'audio' },
		'application/pdf': { url: 'sendDocument', type: 'document' }
	};

	let defaultType = { url: 'sendDocument', type: 'document' };

	const matchedKey = Object.keys(fileTypeMap).find(key => fileType.startsWith(key));
	const { url: endpoint, type: fileTypevalue } = matchedKey ? fileTypeMap[matchedKey] : defaultType;

	// ===== 服务端大小校验 =====
	// 原来是"前端写着 5MB、其实谁都没拦"，用户选个大图能一路提交到 Telegram，
	// 然后收到一个看不懂的 500。现在提前拦下并说清楚原因。
	const isPhoto = endpoint === 'sendPhoto';
	const sizeLimit = isPhoto ? MAX_PHOTO_BYTES : MAX_OTHER_BYTES;
	if (typeof uploadFile.size === 'number' && uploadFile.size > sizeLimit) {
		return Response.json({
			status: 400,
			message: `${isPhoto ? '图片' : '文件'}大小 ${humanSize(uploadFile.size)}，超过 Telegram 的 ${isPhoto ? '10MB（图片）' : '50MB'} 上限，请压缩后再传`,
			success: false
		}, {
			status: 400,
			headers: corsHeaders,
		})
	}

	// ===== 多频道分流 =====
	// 配了 TG_CHAT_ID_VIDEO 的话，视频和动图就存到另一个频道去，
	// 避免大文件把主频道刷屏，也方便以后按类型做备份。
	// 没配就一切照旧，行为完全不变。
	const isVideoLike = endpoint === 'sendVideo' || fileType === 'image/gif';
	const chatId = (isVideoLike && env.TG_CHAT_ID_VIDEO) ? env.TG_CHAT_ID_VIDEO : env.TG_CHAT_ID;

	const up_url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${endpoint}`;
	let newformData = new FormData();
	newformData.append("chat_id", chatId);
	newformData.append(fileTypevalue, uploadFile);

	try {
		const res_img = await fetch(up_url, {
			method: "POST",
			headers: {
				"User-Agent": UA
			},
			body: newformData,
		});


		let responseData = await res_img.json();

		// ===== ★ 关键修复：Telegram 说"不行"的时候要先停下来 =====
		// 文件超限、bot 不是频道管理员、频道不可达……这些情况下 Telegram 会回
		// {ok:false, description:"..."}，而原代码不管三七二十一继续去取
		// responseData.result.file_id —— getFile() 在失败时返回 null，
		// 于是变成 "Cannot read properties of null (reading 'file_id')"。
		// 结果就是：Telegram 明明告诉了你原因，却被这一个类型错误盖住了。
		if (!responseData || responseData.ok !== true || !responseData.result) {
			const reason = (responseData && responseData.description) || `Telegram 返回 HTTP ${res_img.status}`;
			console.error('Telegram 拒绝了这次上传：', reason);
			return Response.json({
				status: 502,
				message: `Telegram 拒绝了这次上传：${reason}`,
				success: false
			}, {
				status: 502,
				headers: corsHeaders,
			})
		}

		const fileData = await getFile(responseData);

		if (!fileData || !fileData.file_id) {
			return Response.json({
				status: 502,
				message: '上传已发出，但没能从 Telegram 的回复里解析出文件信息（这个文件类型可能暂不支持）',
				success: false
			}, {
				status: 502,
				headers: corsHeaders,
			})
		}

		const origin = req_url.origin;

		// ===== 短链（带扩展名）=====
		// 原来返回的是 `${origin}/api/cfile/${file_id}`：又长、又没有扩展名，
		// 公众号／知乎／不少 Markdown 编辑器会因为"URL 不以图片扩展名结尾"而拒收。
		// 现在返回 `${origin}/i/${file_id}.jpg` 这种形式。
		const url = shortLink(origin, fileData.file_id, fileType);

		const data = {
			"url": url,
			"code": 200,
			"name": fileData.file_name
		}

		// ===== 给频道里的图片挂上按钮（1 个打开 + 4 个复制，共 3 行）=====
		await sendLinkButtons(env, responseData, url, chatId);

		if (!env.IMG) {
			data.env_img = "null"
			return Response.json({
				...data,
				msg: "1"
			}, {
				status: 200,
				headers: corsHeaders,
			})
		}

		// nowTime 提到 try 之外先算好，避免 TDZ
		const nowTime = nowTimeString();

		// 写库失败不该让"其实已经成功的上传"变成失败（图片已经进频道了），
		// 但也不能像原代码那样 catch 里什么都不做 —— 至少要在日志里留下痕迹。
		let rating_index = null;
		let dbError = null;
		try {
			await ensureSchema(env.IMG);
			rating_index = await getRating(env, `${fileData.file_id}`);

			// ★ 写入交给共享函数 saveImageInfo（见 src/lib/tg-bot.js）。
			// 为什么不在这里自己写 INSERT：图片一进频道，Telegram 会立刻把这条
			// channel_post 推给 webhook，webhook 那边会给同一个 url 补一条占位记录。
			// 也就是说**这里是和 webhook 并发写同一行的**。
			// 两边都无条件 INSERT 的话（而 imginfo.url 上没有唯一约束），
			// 同一张图就会在后台列表里出现两行。
			// saveImageInfo 用"先更新、没有再插入、最后还是被别人插了再更新一次"
			// 的写法，保证任何交错顺序下都只剩一行、且内容是真实的那份。
			const saved = await saveImageInfo({
				db: env.IMG,
				url: `/cfile/${fileData.file_id}`,
				referer: Referer,
				ip: clientIp,
				rating: rating_index,
				time: nowTime,
				total: 1,
				mode: 'authoritative'
			});
			if (saved && saved.reason === 'merged') {
				console.log('saveImageInfo: 与 webhook 补录撞车，已合并为一行');
			}

			// 记下"这条图片对应频道里的哪条消息"。
			// 以后 /del 命令和讨论组里回复「删除」都靠这张表定位。
			const messageId = responseData.result && responseData.result.message_id;
			if (messageId) {
				await env.IMG.prepare(
					'INSERT OR REPLACE INTO tgmsg (file_id, chat_id, message_id, kind, ts) VALUES (?, ?, ?, ?, ?)'
				).bind(
					fileData.file_id,
					String(chatId),
					messageId,
					fileTypevalue,
					new Date().toISOString()
				).run();
			}
		} catch (error) {
			dbError = error && error.message ? error.message : String(error);
			console.error('写入 D1 失败（图片已上传成功，仅记录失败）：', dbError);
		}

		return Response.json({
			...data,
			msg: "2",
			Referer: Referer,
			clientIp: clientIp,
			rating_index: rating_index,
			nowTime: nowTime,
			...(dbError ? { db_error: dbError } : {})
		}, {
			status: 200,
			headers: corsHeaders,
		})

	} catch (error) {
		return Response.json({
			status: 500,
			message: ` ${error && error.message ? error.message : '未知错误'}`,
			success: false
		}, {
			status: 500,
			headers: corsHeaders,
		})
	}

}


// ===== 给频道里的图片挂上按钮 =====
// 布局（3 行）：
//   🔍 打开图片            ← url 按钮，点一下直接看图（对不熟悉的人最友好）
//   图片直链 | HTML        ← copy_text 按钮，点一下复制到剪贴板
//   Markdown | BBCode
//
// ⚠️ Telegram 的规则：一个按钮只能**二选一**（要么 url、要么 copy_text），
//    所以「打开图片」是**新增一个按钮**，而不是把原来的复制按钮改造出来的。
//
// 布局规律：inline_keyboard 是"行数组的数组"——子数组个数 = 行数，
//           每个子数组里放几个按钮 = 这一行有几列。
//
// 兜底：万一挂按钮失败（例如该消息类型不支持内联键盘），
//       就把四种格式全部写进图片的「说明文字(caption)」，保证内容不丢。
//       整个函数包在 try/catch 内，任何失败都不会影响网页端的上传结果。
async function sendLinkButtons(env, responseData, url, chatId) {
	try {
		const messageId = responseData && responseData.result ? responseData.result.message_id : null;
		if (!messageId) return;

		// 方案 A：挂「1 个打开 + 4 个复制」按钮
		const btnRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageReplyMarkup`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': UA
			},
			body: JSON.stringify({
				chat_id: chatId,
				message_id: messageId,
				reply_markup: buildKeyboard(url)
			}),
		});
		const btnData = await btnRes.json();
		if (btnData && btnData.ok) return;

		// 方案 B（兜底）：挂按钮失败，就把四种格式写进说明文字
		await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageCaption`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': UA
			},
			body: JSON.stringify({
				chat_id: chatId,
				message_id: messageId,
				caption: buildCaption(url)
			}),
		});
	} catch (error) {
		console.log('sendLinkButtons error:', error && error.message);
	}
}


async function getFile_path(env, file_id) {
	try {
		const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file_id)}`;
		const res = await fetch(url, {
			method: 'GET',
			headers: {
				"User-Agent": UA
			},
		})

		let responseData = await res.json();

		if (responseData.ok) {
			const file_path = responseData.result.file_path
			return file_path
		} else {
			return "error";
		}
	} catch (error) {
		return "error";

	}
}

const getFile = async (response) => {
	try {
		if (!response.ok) {
			return null;
		}

		const getFileDetails = (file) => ({
			file_id: file.file_id,
			file_name: file.file_name || file.file_unique_id
		});

		if (response.result.photo) {
			const largestPhoto = response.result.photo.reduce((prev, current) =>
				(prev.file_size > current.file_size) ? prev : current
			);
			return getFileDetails(largestPhoto);
		}

		if (response.result.video) {
			return getFileDetails(response.result.video);
		}

		// 补上 audio —— sendAudio 走的通道原来没有对应分支，
		// 上传音频会走到最后的 return null，然后被当成"解析失败"。
		if (response.result.audio) {
			return getFileDetails(response.result.audio);
		}

		if (response.result.document) {
			return getFileDetails(response.result.document);
		}

		return null;
	} catch (error) {
		console.error('Error getting file id:', error.message);
		return null;
	}
};



async function getRating(env, url) {

	try {
		const file_path = await getFile_path(env, url);

		const apikey = env.ModerateContentApiKey
		const ModerateContentUrl = apikey ? `https://api.moderatecontent.com/moderate/?key=${apikey}&` : ""

		const ratingApi = env.RATINGAPI ? `${env.RATINGAPI}?` : ModerateContentUrl;

		if (ratingApi) {
			// ⚠️ 注意这里：请求的 URL 里带着 Telegram 的文件地址，而文件地址里
			//    含有你的 TG_BOT_TOKEN。也就是说，一旦开启鉴黄，你的 bot token
			//    就交给了这个鉴黄服务方（拿到 token 就能完全控制你的 bot）。
			//    要开请务必让 RATINGAPI 指向你自己部署的服务，不要用公共第三方 API。
			const res = await fetch(`${ratingApi}url=https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${file_path}`);
			const data = await res.json();
			const rating_index = data.hasOwnProperty('rating_index') ? data.rating_index : -1;

			return rating_index;
		} else {
			return 0
		}


	} catch (error) {
		return -1
	}
}
