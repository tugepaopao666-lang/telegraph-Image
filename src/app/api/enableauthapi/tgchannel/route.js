export const runtime = 'edge';
import { getRequestContext } from '@cloudflare/next-on-pages';



const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Max-Age': '86400', // 24 hours
	'Content-Type': 'application/json'
};

const UA = " Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0";

// Telegram 的硬性上限，超了必定被拒。
// 页面上那句"最大 5MB"只是文案，代码里从来没有强制过 —— 这里把服务端校验补上，
// 并且给出人话提示，而不是让 Telegram 的报错被吞掉（见下面的关键修复）。
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;  // sendPhoto：10MB
const MAX_OTHER_BYTES = 50 * 1024 * 1024;  // sendVideo / sendAudio / sendDocument：50MB

function humanSize(bytes) {
	if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '未知大小';
	if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
	if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
	return bytes + ' B';
}

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

	const up_url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${endpoint}`;
	let newformData = new FormData();
	newformData.append("chat_id", env.TG_CHAT_ID);
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

		const data = {
			"url": `${req_url.origin}/api/cfile/${fileData.file_id}`,
			"code": 200,
			"name": fileData.file_name
		}

		// ===== 给频道里的图片挂上「点一下就复制」的四种格式按钮（2×2 两行布局） =====
		await sendLinkButtons(env, responseData, data.url);

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

		// nowTime 提到内层 try 之外先算好。
		// 原代码把它声明在内层 try 里、却在 catch 里引用，一旦异常发生在赋值之前，
		// 那个 catch 会再抛一个 "Cannot access 'nowTime' before initialization"，
		// 把原始错误盖掉。
		const nowTime = await get_nowTime();

		// 写库失败不该让"其实已经成功的上传"变成失败（图片已经进频道了），
		// 但也不能像原代码那样 catch 里什么都不做 —— 至少要在日志里留下痕迹。
		let rating_index = null;
		let dbError = null;
		try {
			rating_index = await getRating(env, `${fileData.file_id}`);
			await insertImageData(env.IMG, `/cfile/${fileData.file_id}`, Referer, clientIp, rating_index, nowTime);
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


// ===== 给频道里的图片挂上四个「点击即复制」的格式按钮（2×2 两行两列） =====
// 效果：图片下方出现一个两行两列的按钮区：
//         图片直链   |   HTML
//         Markdown   |   BBCode
//       点哪个就把对应格式的代码复制到剪贴板（Telegram 会弹「已复制」提示）。
//
// 实现方式：上传成功后调用 editMessageReplyMarkup，给那条图片消息追加一个内联键盘(inline_keyboard)。
//           按钮类型用 copy_text（Telegram Bot API 的"复制文本"按钮）。
//           布局的关键：inline_keyboard 是一个"行数组的数组"——
//           同一子数组里放 2 个按钮 → 这一行显示 2 个（并排）；
//           一共放 2 个子数组 → 共 2 行。合计就是 2×2 的网格。
//           （想改成 1 列或 4 列，只需要调整每个子数组里放几个按钮。）
//
// 四种格式：
//   图片直链  https://你的域名/api/cfile/xxxxx
//   HTML      <img src="https://你的域名/api/cfile/xxxxx">
//   Markdown  ![图片](https://你的域名/api/cfile/xxxxx)
//   BBCode    [img]https://你的域名/api/cfile/xxxxx[/img]
//
// 兜底：万一挂按钮失败（例如该消息类型不支持内联键盘），
//       就把四种格式全部写进图片的「说明文字(caption)」，保证内容不丢。
//       整个函数包在 try/catch 内，任何失败都不会影响网页端的上传结果。
async function sendLinkButtons(env, responseData, url) {
	try {
		const messageId = responseData && responseData.result ? responseData.result.message_id : null;
		if (!messageId) return;

		const ua = UA;

		// 四种格式的具体内容
		const linkDirect = url;
		const linkHtml = '<img src="' + url + '">';
		const linkMarkdown = '![图片](' + url + ')';
		const linkBBCode = '[img]' + url + '[/img]';

		// 方案 A：给图片挂四个「点击即复制」按钮，排成两行两列
		const replyMarkup = {
			inline_keyboard: [
				[
					{ text: '图片直链', copy_text: { text: linkDirect } },
					{ text: 'HTML', copy_text: { text: linkHtml } }
				],
				[
					{ text: 'Markdown', copy_text: { text: linkMarkdown } },
					{ text: 'BBCode', copy_text: { text: linkBBCode } }
				]
			]
		};

		const btnRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageReplyMarkup`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': ua
			},
			body: JSON.stringify({
				chat_id: env.TG_CHAT_ID,
				message_id: messageId,
				reply_markup: replyMarkup
			}),
		});
		const btnData = await btnRes.json();
		if (btnData && btnData.ok) return;

		// 方案 B（兜底）：挂按钮失败，就把四种格式写进说明文字
		let fallbackCaption = '图片直链：\n' + linkDirect +
			'\n\nHTML：\n' + linkHtml +
			'\n\nMarkdown：\n' + linkMarkdown +
			'\n\nBBCode：\n' + linkBBCode;

		// Telegram 的说明文字上限是 1024 字符；正常图片远低于此，
		// 仅对极端长的 file_id 做一次截断保护，避免请求被直接拒绝。
		if (fallbackCaption.length > 1024) {
			fallbackCaption = fallbackCaption.slice(0, 1023) + '…';
		}

		await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageCaption`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': ua
			},
			body: JSON.stringify({
				chat_id: env.TG_CHAT_ID,
				message_id: messageId,
				caption: fallbackCaption
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



async function insertImageData(DB, src, referer, ip, rating, time) {
	// ★ 参数化写入。
	// 原来是把 ${referer} / ${ip} 直接拼进 SQL 字符串 —— 而这两个值来自请求头
	// （Referer、x-forwarded-for），任何访问者都能随手改。绑上 D1 之后，
	// 这就是一条真实可被利用的注入通道。
	// 同时去掉了原来那个空 catch：写库失败不再被静默吞掉。
	await DB.prepare(
		`INSERT INTO imginfo (url, referer, ip, rating, total, time)
		 VALUES (?, ?, ?, ?, 1, ?)`
	).bind(src, referer, ip, rating, time).run();
}



async function get_nowTime() {
	const options = {
		timeZone: 'Asia/Shanghai',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	};
	const timedata = new Date();
	const formattedDate = new Intl.DateTimeFormat('zh-CN', options).format(timedata);

	return formattedDate

}



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
