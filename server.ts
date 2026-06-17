import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import FormData from 'form-data';
import {
    initDatabase,
    hasActiveTask,
    createTask as createDbTask,
    updateTaskByTaskId,
    getLatestTask,
    getTaskByTaskId,
    cleanStaleTasks,
    getTodayUsageCount,
    getQuotaConfig,
    getAllQuotaConfigs,
    upsertQuotaConfig,
    getTaskStats,
} from './db.js';
import {
    submitPhotoRestore,
    submitAnimeConvert,
    submitVoiceClone,
    uploadFileV2,
    submitTextToImage,
    submitTextToSpeech,
    submitWatermarkRemoval,
    submitImageToVideo,
    submitNovelToScript,
} from './runninghub.js';

// ============================================================
// Constants & Helpers
// ============================================================
const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const MOBILE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/** Generate a random msToken-like string */
function generateMsToken(length = 107): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let result = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        result += chars[bytes[i] % chars.length];
    }
    return result;
}

/** Generate a random ttwid-like string */
function generateTtwid(): string {
    return crypto.randomBytes(48).toString('base64url');
}

/** Extract video ID (aweme_id) from any Douyin URL */
function extractVideoId(url: string): string | null {
    // Pattern: /video/7123456789
    const videoMatch = url.match(/\/video\/(\d+)/);
    if (videoMatch) return videoMatch[1];

    // Pattern: /note/7123456789 (图文也可能有视频)
    const noteMatch = url.match(/\/note\/(\d+)/);
    if (noteMatch) return noteMatch[1];

    // Pattern: modal_id=7123456789
    const modalMatch = url.match(/modal_id=(\d+)/);
    if (modalMatch) return modalMatch[1];

    return null;
}

/** Inaccessible Chinese CDN domains → accessible alternatives */
const DOMAIN_REPLACEMENTS: [RegExp, string][] = [
    [/aweme\.snssdk\.com/g, 'www.douyin.com'],
    [/api-h2\.amemv\.com/g, 'www.douyin.com'],
    [/api\.amemv\.com/g, 'www.douyin.com'],
    [/v\d+-[a-z]+\.douyinvod\.com/g, 'www.douyin.com'],
];

/** Replace inaccessible CDN domains with accessible alternatives */
function normalizeVideoUrl(url: string): string {
    let normalized = url;
    for (const [pattern, replacement] of DOMAIN_REPLACEMENTS) {
        normalized = normalized.replace(pattern, replacement);
    }
    return normalized;
}

/**
 * Follow short URL redirects to get the final URL and video ID.
 * Uses manual redirect following to extract video ID as early as possible.
 */
async function resolveShortUrl(shortUrl: string): Promise<{ finalUrl: string; videoId: string | null }> {
    // Quick check: if the URL already contains a video ID, return immediately
    const directId = extractVideoId(shortUrl);
    if (directId) {
        console.log('[Redirect] Video ID found directly in input URL:', directId);
        return { finalUrl: shortUrl, videoId: directId };
    }

    let currentUrl = shortUrl;

    // Manually follow redirects, checking for video ID at each step
    for (let i = 0; i < 10; i++) {
        try {
            const resp = await axios.get(currentUrl, {
                maxRedirects: 0,
                // Only accept 2xx — 3xx will throw so we can handle Location manually
                validateStatus: (s) => s >= 200 && s < 300,
                headers: {
                    'User-Agent': MOBILE_UA,
                    'Accept': 'text/html,application/xhtml+xml',
                },
                timeout: 10000,
            });

            // 2xx — final destination reached
            console.log('[Redirect] Reached final URL (2xx):', currentUrl);
            const videoId = extractVideoId(currentUrl);
            if (videoId) return { finalUrl: currentUrl, videoId };

            // Also try response URL
            const respUrl = resp.request?.res?.responseUrl || resp.request?.responseURL;
            if (respUrl) {
                const idFromResp = extractVideoId(respUrl);
                if (idFromResp) return { finalUrl: respUrl, videoId: idFromResp };
            }
            return { finalUrl: currentUrl, videoId: null };
        } catch (err: any) {
            const status = err.response?.status;
            if (status && status >= 300 && status < 400) {
                const location = err.response.headers['location'];
                if (location) {
                    const nextUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
                    console.log(`[Redirect] ${status} -> ${nextUrl}`);
                    const videoId = extractVideoId(nextUrl);
                    if (videoId) {
                        return { finalUrl: nextUrl, videoId };
                    }
                    currentUrl = nextUrl;
                    continue;
                }
            }
            console.log('[Redirect] Manual following error:', err.message);
            break;
        }
    }

    // Fallback: let axios follow all redirects automatically
    console.log('[Redirect] Falling back to auto-redirect...');
    try {
        const resp = await axios.get(shortUrl, {
            maxRedirects: 10,
            headers: { 'User-Agent': MOBILE_UA },
            timeout: 15000,
        });
        const finalUrl = resp.request?.res?.responseUrl || resp.request?.responseURL || shortUrl;
        console.log('[Redirect] Auto-redirect final URL:', finalUrl);
        return { finalUrl, videoId: extractVideoId(finalUrl) };
    } catch (err: any) {
        const finalUrl = err.request?.res?.responseUrl || err.response?.headers?.['location'] || shortUrl;
        console.log('[Redirect] Auto-redirect failed, last URL:', finalUrl);
        return { finalUrl, videoId: extractVideoId(finalUrl) };
    }
}

/** Deep search an object for video info */
function findVideoInObject(obj: any): { videoSrc: string; coverSrc: string; desc: string } | null {
    if (!obj || typeof obj !== 'object') return null;

    // Check for playApi (newer format)
    if (obj.video && obj.video.playApi) {
        const videoSrc = obj.video.playApi.startsWith('http')
            ? obj.video.playApi
            : 'https:' + obj.video.playApi;
        const coverSrc = obj.video?.cover?.urlList?.[0] || obj.video?.dynamicCover?.urlList?.[0] || '';
        return { videoSrc, coverSrc, desc: obj.desc || '' };
    }

    // Check for play_addr (older format)
    if (obj.video && obj.video.play_addr && obj.video.play_addr.url_list?.length > 0) {
        let videoSrc = obj.video.play_addr.url_list[0];
        videoSrc = videoSrc.replace('playwm', 'play');
        const coverSrc = obj.video?.cover?.url_list?.[0] || '';
        return { videoSrc, coverSrc, desc: obj.desc || '' };
    }

    // Check for download_addr
    if (obj.video && obj.video.download_addr && obj.video.download_addr.url_list?.length > 0) {
        const videoSrc = obj.video.download_addr.url_list[0];
        const coverSrc = obj.video?.cover?.url_list?.[0] || '';
        return { videoSrc, coverSrc, desc: obj.desc || '' };
    }

    // Recurse into children
    for (const key of Object.keys(obj)) {
        const result = findVideoInObject(obj[key]);
        if (result && result.videoSrc) return result;
    }

    return null;
}

// ============================================================
// Express App
// ============================================================
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// Middleware to capture raw body for XML requests (WeChat Webhook configuration and push events)
app.use((req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('xml')) {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            data += chunk;
        });
        req.on('end', () => {
            (req as any).rawBody = data;
            next();
        });
    } else {
        next();
    }
});

// Multer configuration: store files in memory (for forwarding to RunningHub)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max
    },
    fileFilter: (_req, file, cb) => {
        // Allow common image, audio, and video types
        const allowedMimes = [
            'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
            'audio/mpeg', 'audio/wav', 'audio/flac',
            'video/mp4', 'video/avi', 'video/quicktime', 'video/x-matroska',
            'application/zip',
        ];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件类型: ${file.mimetype}`));
        }
    },
});
/**
 * Helper to exchange WeChat code for openid and optional unionid.
 */
async function getOpenIdFromCode(code: string): Promise<{ openid: string; unionid?: string }> {
    const appId = process.env.WECHAT_APPID;
    const appSecret = process.env.WECHAT_SECRET;

    if (!appId || !appSecret) {
        console.error('[Wechat] WECHAT_APPID or WECHAT_SECRET not configured');
        throw new Error('服务端微信配置缺失，请联系管理员');
    }

    console.log('[Wechat] Exchanging code for openid...');

    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
        params: {
            appid: appId,
            secret: appSecret,
            js_code: code,
            grant_type: 'authorization_code',
        },
        timeout: 10000,
    });

    const wxData = wxRes.data;
    console.log('[Wechat] WeChat response:', JSON.stringify({
        openid: wxData.openid ? '***' : undefined,
        errcode: wxData.errcode,
        errmsg: wxData.errmsg,
    }));

    if (wxData.errcode && wxData.errcode !== 0) {
        const errorMessages: Record<number, string> = {
            40029: 'code 无效或已过期，请重新调用 wx.login',
            45011: '请求频率限制，请稍后再试',
            40226: '高风险等级用户，小程序登录拦截',
            [-1]: '微信系统繁忙，请稍后再试',
        };
        const msg = errorMessages[wxData.errcode] || wxData.errmsg || '微信登录失败';
        const err = new Error(msg) as any;
        err.errcode = wxData.errcode;
        throw err;
    }

    if (!wxData.openid) {
        throw new Error('微信登录异常：未返回 openid');
    }

    return {
        openid: wxData.openid,
        unionid: wxData.unionid,
    };
}

let cachedWechatToken: string | null = null;
let cachedWechatTokenExpiresAt = 0;

/**
 * Helper to get cached or fresh WeChat API Access Token.
 */
async function getWechatAccessToken(): Promise<string> {
    const now = Date.now();
    // Return cached token if valid (with 5-minute safety buffer)
    if (cachedWechatToken && cachedWechatTokenExpiresAt > now + 300000) {
        return cachedWechatToken;
    }

    const appId = process.env.WECHAT_APPID;
    const appSecret = process.env.WECHAT_SECRET;

    if (!appId || !appSecret) {
        console.error('[Wechat] WECHAT_APPID or WECHAT_SECRET not configured');
        throw new Error('服务端微信配置缺失，请联系管理员');
    }

    console.log('[Wechat] Fetching new access token from WeChat...');
    const tokenRes = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
        params: {
            grant_type: 'client_credential',
            appid: appId,
            secret: appSecret,
        },
        timeout: 10000,
    });

    const tokenData = tokenRes.data;
    if (tokenData.errcode && tokenData.errcode !== 0) {
        console.error('[Wechat] Failed to fetch access token:', tokenData.errmsg);
        throw new Error(`获取微信 AccessToken 失败: ${tokenData.errmsg}`);
    }

    if (!tokenData.access_token) {
        throw new Error('获取微信 AccessToken 异常：未返回 access_token');
    }

    cachedWechatToken = tokenData.access_token;
    cachedWechatTokenExpiresAt = now + (tokenData.expires_in * 1000);
    console.log(`[Wechat] Access token updated. Expires in ${tokenData.expires_in} seconds.`);

    return tokenData.access_token;
}

// ============================================================
// Admin Authentication Middleware
// ============================================================
function adminAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
        return res.status(500).json({ success: false, error: '服务端未配置 ADMIN_TOKEN' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: '未授权：缺少 Authorization 头' });
    }

    const token = authHeader.substring(7);
    if (token !== adminToken) {
        return res.status(401).json({ success: false, error: '未授权：Token 无效' });
    }

    next();
}

// ============================================================
// Admin API: POST /api/admin/login — 管理端登录
// ============================================================
app.post('/api/admin/login', (req, res) => {
    const { token } = req.body;
    const adminToken = process.env.ADMIN_TOKEN;

    if (!adminToken) {
        return res.status(500).json({ success: false, error: '服务端未配置 ADMIN_TOKEN' });
    }

    if (!token || typeof token !== 'string') {
        return res.status(400).json({ success: false, error: 'token 参数必填' });
    }

    if (token !== adminToken) {
        return res.status(401).json({ success: false, error: 'Token 验证失败' });
    }

    res.json({
        success: true,
        message: '登录成功',
        data: { token },
    });
});

// ============================================================
// Admin API: GET /api/admin/dashboard — 仪表盘数据
// ============================================================
app.get('/api/admin/dashboard', adminAuthMiddleware, async (_req, res) => {
    try {
        const stats = await getTaskStats();

        // Calculate totals
        let totalCount = 0;
        let todayCount = 0;
        for (const s of stats) {
            totalCount += s.total_count;
            todayCount += s.today_count;
        }

        res.json({
            success: true,
            data: {
                totalCount,
                todayCount,
                items: stats,
            },
        });
    } catch (error: any) {
        console.error('[AdminDashboard] Error:', error.message);
        res.status(500).json({ success: false, error: '获取仪表盘数据失败：' + error.message });
    }
});

// ============================================================
// Admin API: GET /api/admin/quota — 获取所有限额配置
// ============================================================
app.get('/api/admin/quota', adminAuthMiddleware, async (_req, res) => {
    try {
        const configs = await getAllQuotaConfigs();
        res.json({ success: true, data: configs });
    } catch (error: any) {
        console.error('[AdminQuota] Error:', error.message);
        res.status(500).json({ success: false, error: '获取限额配置失败：' + error.message });
    }
});

// ============================================================
// Admin API: PUT /api/admin/quota — 更新限额配置
// ============================================================
app.put('/api/admin/quota', adminAuthMiddleware, async (req, res) => {
    try {
        const { bizCode, bizName, dailyFreeLimit, dailyMaxLimit } = req.body;

        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (!bizName || typeof bizName !== 'string') {
            return res.status(400).json({ success: false, error: 'bizName 参数必填' });
        }
        if (typeof dailyFreeLimit !== 'number' || dailyFreeLimit < 0) {
            return res.status(400).json({ success: false, error: 'dailyFreeLimit 必须为非负整数' });
        }
        if (typeof dailyMaxLimit !== 'number' || dailyMaxLimit < 1) {
            return res.status(400).json({ success: false, error: 'dailyMaxLimit 必须为正整数' });
        }
        if (dailyMaxLimit <= dailyFreeLimit) {
            return res.status(400).json({ success: false, error: '每日最大调用次数必须大于每日免费调用次数' });
        }

        const config = await upsertQuotaConfig(bizCode, bizName, dailyFreeLimit, dailyMaxLimit);
        console.log(`[AdminQuota] Updated quota for ${bizCode}: free=${dailyFreeLimit}, max=${dailyMaxLimit}`);

        res.json({ success: true, message: '限额配置已保存', data: config });
    } catch (error: any) {
        console.error('[AdminQuota] Error:', error.message);
        res.status(500).json({ success: false, error: '保存限额配置失败：' + error.message });
    }
});

// ============================================================
// Helper: Check daily quota for a user + biz_code
// ============================================================
/**
 * Check if a user has exceeded the daily max quota for a given biz_code.
 * Returns null if within quota, or an error message string if exceeded.
 */
async function checkDailyQuota(openid: string, bizCode: string): Promise<string | null> {
    const quotaConfig = await getQuotaConfig(bizCode);
    if (!quotaConfig) {
        // No quota config means no limit
        return null;
    }

    const todayCount = await getTodayUsageCount(openid, bizCode);
    if (todayCount >= quotaConfig.daily_max_limit) {
        return `今日调用次数已达上限（最大 ${quotaConfig.daily_max_limit} 次/天），请明天再试`;
    }

    return null;
}

// ============================================================
// API: GET /api/quota/remaining — 查询当日免费剩余调用次数
// ============================================================
app.get('/api/quota/remaining', async (req, res) => {
    try {
        const { code, bizCode } = req.query;

        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        const quotaConfig = await getQuotaConfig(bizCode);
        if (!quotaConfig) {
            return res.status(404).json({ success: false, error: '未找到该业务功能的限额配置' });
        }

        const todayCount = await getTodayUsageCount(openid, bizCode);
        const remaining = Math.max(0, quotaConfig.daily_free_limit - todayCount);

        console.log(`[QuotaRemaining] openid=${openid}, bizCode=${bizCode}, todayCount=${todayCount}, freeLimit=${quotaConfig.daily_free_limit}, remaining=${remaining}`);

        res.json({
            success: true,
            data: {
                bizCode,
                bizName: quotaConfig.biz_name,
                dailyFreeLimit: quotaConfig.daily_free_limit,
                dailyMaxLimit: quotaConfig.daily_max_limit,
                todayUsed: todayCount,
                freeRemaining: remaining,
            },
        });
    } catch (error: any) {
        console.error('[QuotaRemaining] Error:', error.message);
        res.status(500).json({ success: false, error: '查询失败：' + (error.message || '未知错误') });
    }
});

// ============================================================
// API: POST /api/wechat/login — 微信小程序登录（code 换取 openid）
// ============================================================
app.post('/api/wechat/login', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }

        const wxData = await getOpenIdFromCode(code);

        // Return openid (and optionally unionid if available)
        // NOTE: session_key MUST NOT be sent to the client for security reasons
        const responseData: any = {
            openid: wxData.openid,
        };
        if (wxData.unionid) {
            responseData.unionid = wxData.unionid;
        }

        res.json({
            success: true,
            message: '登录成功',
            data: responseData,
        });
    } catch (error: any) {
        console.error('[WechatLogin] Error:', error.message);
        const status = error.errcode ? 400 : 500;
        res.status(status).json({
            success: false,
            error: '微信登录失败：' + (error.message || '未知错误'),
            errcode: error.errcode,
        });
    }
});

// ============================================================
// API: GET /api/wechat/webhook — 微信小程序消息推送服务器配置校验
// ============================================================
app.get('/api/wechat/webhook', (req, res) => {
    const { signature, timestamp, nonce, echostr } = req.query;
    const token = process.env.WECHAT_TOKEN;

    console.log('[WechatWebhook] Verification request received:', JSON.stringify(req.query));

    if (!token) {
        console.warn('[WechatWebhook] WECHAT_TOKEN environment variable not set, skipping signature validation.');
        return res.send(echostr);
    }

    if (!signature || !timestamp || !nonce) {
        return res.status(400).send('Invalid parameters');
    }

    const tempArr = [token, timestamp, nonce].sort();
    const tempStr = tempArr.join('');
    const hash = crypto.createHash('sha1').update(tempStr).digest('hex');

    if (hash === signature) {
        res.send(echostr);
    } else {
        console.warn('[WechatWebhook] Signature validation failed');
        res.status(403).send('Signature verification failed');
    }
});

// ============================================================
// API: POST /api/wechat/webhook — 接收微信消息推送回调（XML 或 JSON）
// ============================================================
app.post('/api/wechat/webhook', async (req, res) => {
    try {
        let event = '';
        let traceId = '';
        let isRisky = 0;
        let statusCode = 0;
        let extraInfoStr = '';

        // WeChat webhook can be sent in either JSON or XML format depending on WeChat settings.
        const contentType = req.headers['content-type'] || '';
        const rawXml = (req as any).rawBody;

        if (contentType.includes('xml') && rawXml) {
            console.log('[WechatWebhook] Parsing XML callback...');
            const $ = cheerio.load(rawXml, { xmlMode: true });
            event = $('Event').text() || $('event').text() || '';
            traceId = $('trace_id').text() || $('traceId').text() || '';
            const riskyText = $('isrisky').text() || $('isRisky').text() || '0';
            isRisky = parseInt(riskyText, 10);
            const statusText = $('status_code').text() || $('statusCode').text() || '0';
            statusCode = parseInt(statusText, 10);
            extraInfoStr = $('extra_info_json').text() || $('extraInfoJson').text() || '';
        } else {
            console.log('[WechatWebhook] Parsing JSON callback...');
            const body = req.body || {};
            event = body.Event || body.event || '';
            traceId = body.trace_id || body.traceId || '';
            isRisky = typeof body.isrisky === 'number' ? body.isrisky : parseInt(body.isrisky || '0', 10);
            statusCode = typeof body.status_code === 'number' ? body.status_code : parseInt(body.status_code || '0', 10);
            extraInfoStr = typeof body.extra_info_json === 'string' ? body.extra_info_json : JSON.stringify(body.extra_info_json || {});
        }

        console.log(`[WechatWebhook] Event: ${event}, traceId: ${traceId}, isRisky: ${isRisky}, statusCode: ${statusCode}`);

        if (event === 'wxa_media_check') {
            if (!traceId) {
                console.warn('[WechatWebhook] wxa_media_check event received without trace_id');
                return res.send('success');
            }

            // Look up task in DB
            const task = await getTaskByTaskId(traceId);
            if (!task) {
                console.warn(`[WechatWebhook] Task not found for trace_id: ${traceId}`);
                return res.send('success');
            }

            let status = 'SUCCESS';
            let errorMessage: string | null = null;
            let outputData: any = {
                isRisky,
                statusCode,
            };

            try {
                if (extraInfoStr) {
                    outputData.extraInfo = JSON.parse(extraInfoStr);
                }
            } catch (e) {
                outputData.extraInfoRaw = extraInfoStr;
            }

            // status_code -1008 means failed to download resource
            if (statusCode !== 0) {
                status = 'FAILED';
                if (statusCode === 4294966288 || statusCode === -1008) {
                    errorMessage = '微信下载多媒体文件失败（-1008），请确保链接公开可访问并且没有被防盗链拦截';
                } else {
                    errorMessage = `内容安全检测处理出错，错误码：${statusCode}`;
                }
            } else if (isRisky === 1) {
                status = 'FAILED';
                errorMessage = '内容含有违规信息，已被拦截';
            }

            await updateTaskByTaskId(traceId, status, outputData, task.input_image_url, errorMessage);
            console.log(`[WechatWebhook] Successfully updated task ${traceId} to ${status}`);
        } else {
            console.log(`[WechatWebhook] Ignored event: ${event}`);
        }

        // WeChat requires replying with success or empty string to acknowledge receipt
        res.send('success');
    } catch (error: any) {
        console.error('[WechatWebhook] Error processing webhook:', error.message);
        // Reply success even on error to prevent WeChat from continuously retrying
        res.send('success');
    }
});

// ============================================================
// API: POST /api/wechat/msg_sec_check — 文本内容安全识别
// ============================================================
app.post('/api/wechat/msg_sec_check', async (req, res) => {
    try {
        const { code, openid: inputOpenid, content, scene } = req.body;

        if (!content || typeof content !== 'string') {
            return res.status(400).json({ success: false, error: 'content 参数必填且必须为字符串' });
        }

        // Validate content length (WeChat limits to 2500 characters)
        if (content.length > 2500) {
            return res.status(400).json({ success: false, error: 'content 长度不能超过 2500 字' });
        }

        let openid = inputOpenid;
        if (!openid) {
            if (!code || typeof code !== 'string') {
                return res.status(400).json({ success: false, error: 'code 或 openid 参数必选其一' });
            }
            try {
                const wxData = await getOpenIdFromCode(code);
                openid = wxData.openid;
            } catch (err: any) {
                return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
            }
        }

        console.log(`[MsgSecCheck] openid=${openid}, content length=${content.length}`);

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'msg_sec_check');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Create a pending record in tasks for quota increment
        const taskId = `msgsec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        await createDbTask(openid, 'msg_sec_check', taskId, content.substring(0, 100));

        // Get WeChat access token
        const accessToken = await getWechatAccessToken();

        // Call WeChat msgSecCheck API
        const wxRes = await axios.post(`https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${accessToken}`, {
            version: 2,
            openid: openid,
            scene: typeof scene === 'number' ? scene : 2, // Default to comment/forum scene
            content: content,
        }, {
            timeout: 10000,
        });

        const wxData = wxRes.data;
        console.log('[MsgSecCheck] WeChat response:', JSON.stringify(wxData));

        if (wxData.errcode && wxData.errcode !== 0) {
            await updateTaskByTaskId(taskId, 'FAILED', wxData, null, wxData.errmsg || '微信文本检测接口调用失败');
            return res.status(500).json({
                success: false,
                error: `微信接口调用失败: ${wxData.errmsg}`,
                errcode: wxData.errcode,
            });
        }

        const result = wxData.result || {};
        const suggest = result.suggest || 'pass'; // 'pass', 'block', 'review'
        const label = result.label || 100;
        
        let status = 'SUCCESS';
        let errorMessage: string | null = null;
        if (suggest === 'block') {
            status = 'FAILED';
            errorMessage = '内容含有违规信息，已被拦截';
        }

        await updateTaskByTaskId(taskId, status, wxData, null, errorMessage);

        res.json({
            success: true,
            data: {
                suggest, // pass, block, review
                label,
                detail: result.detail || [],
            },
        });
    } catch (error: any) {
        console.error('[MsgSecCheck] Unhandled error:', error.message);
        res.status(500).json({
            success: false,
            error: '文本安全检测失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/wechat/media_check_async — 异步多媒体内容安全识别
// ============================================================
app.post('/api/wechat/media_check_async', upload.single('file'), async (req, res) => {
    try {
        const { code, openid: inputOpenid, mediaUrl: inputMediaUrl, mediaType, scene } = req.body;
        const file = req.file;

        let mediaUrl = inputMediaUrl;

        // If file is uploaded directly, upload to RunningHub V2 first to get public downloadUrl
        if (file) {
            console.log(`[MediaCheckAsync] Uploaded file received: ${file.originalname}, size: ${file.size}, type: ${file.mimetype}`);
            try {
                const uploadResult = await uploadFileV2(file.buffer, file.originalname, file.mimetype);
                mediaUrl = uploadResult.downloadUrl;
                console.log(`[MediaCheckAsync] File forwarded to RunningHub. URL: ${mediaUrl}`);
            } catch (err: any) {
                console.error('[MediaCheckAsync] Forwarding file to RunningHub failed:', err.message);
                return res.status(500).json({ success: false, error: `文件转存公共链接失败: ${err.message}` });
            }
        }

        if (!mediaUrl || typeof mediaUrl !== 'string') {
            return res.status(400).json({ success: false, error: 'mediaUrl 参数必填，或通过 multipart/form-data 上传 file 字段' });
        }

        if (!mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://')) {
            return res.status(400).json({ success: false, error: 'mediaUrl 格式无效，需以 http:// 或 https:// 开头' });
        }

        const typeNum = typeof mediaType === 'number' ? mediaType : parseInt(mediaType || '2', 10);
        if (typeNum !== 1 && typeNum !== 2) {
            return res.status(400).json({ success: false, error: 'mediaType 参数无效，1-音频，2-图片' });
        }

        let openid = inputOpenid;
        if (!openid) {
            if (!code || typeof code !== 'string') {
                return res.status(400).json({ success: false, error: 'code 或 openid 参数必选其一' });
            }
            try {
                const wxData = await getOpenIdFromCode(code);
                openid = wxData.openid;
            } catch (err: any) {
                return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
            }
        }

        console.log(`[MediaCheckAsync] openid=${openid}, mediaUrl=${mediaUrl.substring(0, 100)}, mediaType=${typeNum}`);

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'media_sec_check');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Get WeChat access token
        const accessToken = await getWechatAccessToken();

        // Call WeChat mediaCheckAsync API
        const wxRes = await axios.post(`https://api.weixin.qq.com/wxa/media_check_async?access_token=${accessToken}`, {
            version: 2,
            openid: openid,
            scene: typeof scene === 'number' ? scene : 2, // Default to comment/forum scene
            media_type: typeNum,
            media_url: mediaUrl,
        }, {
            timeout: 10000,
        });

        const wxData = wxRes.data;
        console.log('[MediaCheckAsync] WeChat response:', JSON.stringify(wxData));

        if (wxData.errcode && wxData.errcode !== 0) {
            return res.status(500).json({
                success: false,
                error: `微信接口调用失败: ${wxData.errmsg}`,
                errcode: wxData.errcode,
            });
        }

        const traceId = wxData.trace_id;
        if (!traceId) {
            return res.status(500).json({
                success: false,
                error: '微信接口调用异常，未返回 trace_id',
            });
        }

        // Create a task record in tasks table
        const task = await createDbTask(openid, 'media_sec_check', traceId, mediaUrl);
        console.log(`[MediaCheckAsync] Task created in DB: id=${task.id}, traceId=${traceId}`);

        res.json({
            success: true,
            message: '多媒体安全检测任务已提交，结果将通过微信回调异步推送，可使用 task_id 查询状态',
            data: {
                taskId: traceId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[MediaCheckAsync] Unhandled error:', error.message);
        res.status(500).json({
            success: false,
            error: '多媒体安全检测提交失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/wechat/user_risk_rank — 获取用户安全等级 (防刷防防黑产)
// ============================================================
app.post('/api/wechat/user_risk_rank', async (req, res) => {
    try {
        const { code, openid: inputOpenid, scene, clientIp, mobileNo, emailAddress, extendedInfo } = req.body;

        let openid = inputOpenid;
        if (!openid) {
            if (!code || typeof code !== 'string') {
                return res.status(400).json({ success: false, error: 'code 或 openid 参数必选其一' });
            }
            try {
                const wxData = await getOpenIdFromCode(code);
                openid = wxData.openid;
            } catch (err: any) {
                return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
            }
        }

        // clientIp is required for risk assessment
        const ip = clientIp || req.ip || req.socket.remoteAddress || '127.0.0.1';

        console.log(`[UserRiskRank] openid=${openid}, ip=${ip}, scene=${scene}`);

        // Get WeChat access token
        const accessToken = await getWechatAccessToken();

        // Call WeChat getUserRiskRank API
        const wxRes = await axios.post(`https://api.weixin.qq.com/wxa/getuserriskrank?access_token=${accessToken}`, {
            appid: process.env.WECHAT_APPID,
            openid: openid,
            scene: typeof scene === 'number' ? scene : 1, // Default scene (e.g. registration/login)
            client_ip: ip,
            mobile_no: mobileNo,
            email_address: emailAddress,
            extended_info: extendedInfo,
        }, {
            timeout: 10000,
        });

        const wxData = wxRes.data;
        console.log('[UserRiskRank] WeChat response:', JSON.stringify(wxData));

        if (wxData.errcode && wxData.errcode !== 0) {
            return res.status(500).json({
                success: false,
                error: `微信接口调用失败: ${wxData.errmsg}`,
                errcode: wxData.errcode,
            });
        }

        res.json({
            success: true,
            data: {
                riskRank: wxData.risk_rank, // 用户风险等级：0-无风险，1-低风险，2-中风险，3-高风险，4-极高风险
                unionsig: wxData.unionsig,   // 唯一签名标识
            },
        });
    } catch (error: any) {
        console.error('[UserRiskRank] Unhandled error:', error.message);
        res.status(500).json({
            success: false,
            error: '获取用户安全等级失败：' + (error.message || '未知错误'),
        });
    }
});

/**
 * Extract and parse Douyin video URL from input string using multiple strategies.
 */
async function getDouyinVideoUrl(url: string): Promise<{ videoSrc: string; coverSrc: string; desc: string }> {
    // Extract URL from pasted message text
    let targetUrl = url;
    const urlMatch = url.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
        targetUrl = urlMatch[0];
    }

    console.log('[Parse] Input URL:', targetUrl);

    // Step 1: Resolve short URL to get video ID
    const { finalUrl, videoId } = await resolveShortUrl(targetUrl);
    console.log('[Parse] Final URL:', finalUrl, '| Video ID:', videoId);

    if (!videoId) {
        throw new Error('无法从链接中提取视频ID，请检查链接格式');
    }

    let videoSrc = '';
    let coverSrc = '';
    let desc = '';

    // ------ Strategy 1: Douyin Web API with msToken ------
    console.log('[Parse] Strategy 1: Douyin Web API...');
    try {
        const msToken = generateMsToken();
        const ttwid = generateTtwid();
        const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${videoId}&aid=6383&cookie_enabled=true&platform=PC&downlink=10`;

        const apiRes = await axios.get(apiUrl, {
            headers: {
                'User-Agent': DESKTOP_UA,
                'Referer': 'https://www.douyin.com/',
                'Cookie': `msToken=${msToken}; ttwid=${ttwid}; odin_tt=324fb4ea4a89c0c05827e18a1ed9cf9bf8a17f7705fcc793fec935b637867e2a5a9b8168c885554d029919117a18ba69; passport_csrf_token=3571e3e6a307e1c3b29a6de5dd205e69`,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            timeout: 15000,
        });

        const detail = apiRes.data?.aweme_detail;
        if (detail) {
            const result = findVideoInObject(detail);
            if (result && result.videoSrc) {
                videoSrc = result.videoSrc;
                coverSrc = result.coverSrc;
                desc = result.desc;
                console.log('[Parse] Strategy 1 SUCCESS');
            }
        }
    } catch (e: any) {
        console.log('[Parse] Strategy 1 failed:', e.message);
    }

    // ------ Strategy 2: Fetch page with Desktop UA + parse RENDER_DATA ------
    if (!videoSrc) {
        console.log('[Parse] Strategy 2: Desktop page RENDER_DATA...');
        try {
            const pageUrl = `https://www.douyin.com/video/${videoId}`;
            const msToken = generateMsToken();
            const ttwid = generateTtwid();

            const pageRes = await axios.get(pageUrl, {
                headers: {
                    'User-Agent': DESKTOP_UA,
                    'Referer': 'https://www.douyin.com/',
                    'Cookie': `msToken=${msToken}; ttwid=${ttwid}`,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                },
                maxRedirects: 5,
                timeout: 15000,
            });

            const html = pageRes.data;
            const $ = cheerio.load(html);

            // Try RENDER_DATA
            const renderDataEl = $('#RENDER_DATA');
            if (renderDataEl.length > 0) {
                const decoded = decodeURIComponent(renderDataEl.html() || '');
                const renderData = JSON.parse(decoded);
                const result = findVideoInObject(renderData);
                if (result && result.videoSrc) {
                    videoSrc = result.videoSrc;
                    coverSrc = result.coverSrc;
                    desc = result.desc;
                    console.log('[Parse] Strategy 2 (RENDER_DATA) SUCCESS');
                }
            }

            // Try _ROUTER_DATA or SSR_HYDRATED_DATA
            if (!videoSrc) {
                $('script').each((_i, el) => {
                    if (videoSrc) return;
                    const content = $(el).html() || '';

                    // Try various JSON data patterns
                    for (const pattern of [
                        /window\._ROUTER_DATA\s*=\s*(\{.+\})\s*;?\s*$/ms,
                        /self\.__next_f\.push\(\[.*?"(\{.*?\})"\]/s,
                    ]) {
                        const match = content.match(pattern);
                        if (match) {
                            try {
                                const data = JSON.parse(match[1]);
                                const result = findVideoInObject(data);
                                if (result && result.videoSrc) {
                                    videoSrc = result.videoSrc;
                                    coverSrc = result.coverSrc;
                                    desc = result.desc;
                                    console.log('[Parse] Strategy 2 (router data) SUCCESS');
                                    return;
                                }
                            } catch { }
                        }
                    }
                });
            }
        } catch (e: any) {
            console.log('[Parse] Strategy 2 failed:', e.message);
        }
    }

    // ------ Strategy 3: Mobile page scraping ------
    if (!videoSrc) {
        console.log('[Parse] Strategy 3: Mobile page scraping...');
        try {
            const mobileUrl = `https://m.douyin.com/share/video/${videoId}`;
            const pageRes = await axios.get(mobileUrl, {
                headers: {
                    'User-Agent': MOBILE_UA,
                    'Accept': 'text/html,application/xhtml+xml',
                },
                maxRedirects: 5,
                timeout: 15000,
            });

            const html = pageRes.data;
            const $ = cheerio.load(html);

            // Search all script tags for video data
            $('script').each((_i, el) => {
                if (videoSrc) return;
                const content = $(el).html() || '';

                // Look for playAddr patterns
                if (content.includes('playAddr') || content.includes('play_addr') || content.includes('playApi')) {
                    // Try to extract any video URL
                    const patterns = [
                        /"playApi"\s*:\s*"([^"]+)"/,
                        /"play_addr".*?"url_list"\s*:\s*\["([^"]+)"/,
                        /"playAddr"\s*:\s*\[\{"src"\s*:\s*"([^"]+)"/,
                    ];
                    for (const p of patterns) {
                        const m = content.match(p);
                        if (m && m[1]) {
                            let src = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
                            videoSrc = src.startsWith('//') ? 'https:' + src : src.startsWith('http') ? src : 'https:' + src;
                            videoSrc = videoSrc.replace('playwm', 'play');
                            console.log('[Parse] Strategy 3 SUCCESS');
                            break;
                        }
                    }
                }
            });

            // Generic mp4 search
            if (!videoSrc) {
                const mp4Match = html.match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/);
                if (mp4Match) {
                    videoSrc = mp4Match[0];
                    console.log('[Parse] Strategy 3 (mp4 regex) SUCCESS');
                }
            }
        } catch (e: any) {
            console.log('[Parse] Strategy 3 failed:', e.message);
        }
    }

    // ------ Strategy 4: iesdouyin API ------
    if (!videoSrc) {
        console.log('[Parse] Strategy 4: iesdouyin API...');
        try {
            const apiRes = await axios.get(
                `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`,
                {
                    headers: { 'User-Agent': MOBILE_UA },
                    timeout: 10000,
                }
            );
            const itemList = apiRes.data?.item_list;
            if (itemList && itemList.length > 0) {
                const item = itemList[0];
                if (item.video?.play_addr?.url_list?.[0]) {
                    videoSrc = item.video.play_addr.url_list[0].replace('playwm', 'play');
                    coverSrc = item.video?.cover?.url_list?.[0] || '';
                    desc = item.desc || '';
                    console.log('[Parse] Strategy 4 SUCCESS');
                }
            }
        } catch (e: any) {
            console.log('[Parse] Strategy 4 failed:', e.message);
        }
    }

    // ------ Strategy 5: Construct direct CDN URL ------
    if (!videoSrc) {
        console.log('[Parse] Strategy 5: Direct CDN construction...');
        try {
            // Some Douyin videos can be accessed via a constructed URL
            const cdnUrl = `https://www.douyin.com/aweme/v1/play/?video_id=${videoId}&ratio=720p&line=0`;
            const headRes = await axios.head(cdnUrl, {
                headers: { 'User-Agent': MOBILE_UA },
                maxRedirects: 3,
                timeout: 10000,
            });
            if (headRes.status === 200) {
                videoSrc = cdnUrl;
                console.log('[Parse] Strategy 5 SUCCESS');
            }
        } catch (e: any) {
            console.log('[Parse] Strategy 5 failed:', e.message);
        }
    }

    // If all strategies fail
    if (!videoSrc) {
        console.log('[Parse] All strategies failed for video ID:', videoId);
        throw new Error('解析失败，所有策略均无法获取视频地址。可能原因：1) 视频已删除 2) 服务器IP被限制 3) 链接格式不支持');
    }

    // Normalize domains for accessibility from overseas servers
    videoSrc = normalizeVideoUrl(videoSrc);
    console.log('[Parse] Final video URL (normalized):', videoSrc.substring(0, 120) + '...');

    return {
        videoSrc,
        coverSrc,
        desc: desc || '抖音视频',
    };
}

// ============================================================
// API: POST /api/parse — 视频去水印（解析抖音视频链接）
// ============================================================
app.post('/api/parse', async (req, res) => {
    try {
        const { code, bizCode, url } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (bizCode !== 'video_parse') {
            return res.status(400).json({ success: false, error: 'bizCode 必须为 video_parse' });
        }
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ success: false, error: 'url 参数必填（抖音视频链接）' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[VideoParse] Request from openid=${openid}, bizCode=${bizCode}, url=${url}`);

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'video_parse');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Parse Douyin video URL (synchronous processing)
        const result = await getDouyinVideoUrl(url);

        // Generate a unique task ID for the record
        const taskId = `parse_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

        // Write a SUCCESS record directly (synchronous task, no async processing)
        const task = await createDbTask(openid, 'video_parse', taskId, url);
        await updateTaskByTaskId(taskId, 'SUCCESS', {
            url: result.videoSrc,
            cover: result.coverSrc,
            desc: result.desc,
        }, result.videoSrc, null);

        console.log(`[VideoParse] Task created and completed: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            data: {
                taskId: taskId,
                url: result.videoSrc,
                cover: result.coverSrc,
                desc: result.desc,
            },
        });
    } catch (error: any) {
        console.error('[VideoParse] Unhandled error:', error.message);
        res.status(500).json({
            success: false,
            error: '解析视频失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: GET /api/proxy — 流式代理视频下载（无大小限制）
// ============================================================
app.get('/api/proxy', async (req, res) => {
    const { url, download } = req.query;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Normalize the URL to use accessible domains
    const normalizedUrl = normalizeVideoUrl(url);
    console.log('[Proxy] Downloading:', normalizedUrl.substring(0, 120));

    try {
        const response = await axios.get(normalizedUrl, {
            responseType: 'stream',
            headers: {
                'User-Agent': MOBILE_UA,
                'Referer': 'https://www.douyin.com/',
            },
            timeout: 120000,
            maxRedirects: 10,
        });

        // Forward content headers
        const contentType = response.headers['content-type'] || 'video/mp4';
        const contentLength = response.headers['content-length'];

        res.setHeader('Content-Type', contentType);
        if (download === '1') {
            res.setHeader('Content-Disposition', 'attachment; filename="douyin_video.mp4"');
        }
        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }

        // Pipe the video stream to the client
        response.data.pipe(res);
    } catch (error: any) {
        console.error('[Proxy] Error:', error.message);
        res.status(500).json({ error: '视频下载失败，请稍后重试' });
    }
});

// ============================================================
// API: POST /api/upload — 文件上传（转发至 RunningHub）
// ============================================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({
                success: false,
                error: '请上传文件（字段名: file）',
            });
        }

        console.log(`[Upload] Received file: ${file.originalname}, size: ${file.size}, type: ${file.mimetype}`);

        // Forward the file to RunningHub V2 upload API
        const result = await uploadFileV2(file.buffer, file.originalname, file.mimetype);

        console.log(`[Upload] Success: downloadUrl=${result.downloadUrl?.substring(0, 80)}, fileName=${result.fileName}`);

        res.json({
            success: true,
            message: '文件上传成功',
            data: {
                /** 公网可访问的下载链接（有效期约1天） */
                downloadUrl: result.downloadUrl,
                /** RunningHub 内部文件名，用于后续工作流接口调用 */
                fileName: result.fileName,
                /** 文件类型 */
                type: result.type,
                /** 文件大小（字节） */
                size: result.size,
            },
        });
    } catch (error: any) {
        console.error('[Upload] Error:', error.message);

        // Handle multer-specific errors
        if (error instanceof multer.MulterError) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    success: false,
                    error: '文件大小超过限制（最大 10MB）',
                });
            }
            return res.status(400).json({
                success: false,
                error: `文件上传错误: ${error.message}`,
            });
        }

        // Handle file type validation errors
        if (error.message?.includes('不支持的文件类型')) {
            return res.status(400).json({
                success: false,
                error: error.message,
            });
        }

        res.status(500).json({
            success: false,
            error: '文件上传失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/photo/restore — 发起老照片修复任务
// ============================================================
app.post('/api/photo/restore', async (req, res) => {
    try {
        const { code, bizCode, imageUrl, cnStrength, outputSize } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (!imageUrl || typeof imageUrl !== 'string') {
            return res.status(400).json({ success: false, error: 'imageUrl 参数必填' });
        }

        // Validate imageUrl format
        if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
            return res.status(400).json({ success: false, error: 'imageUrl 格式无效，需以 http:// 或 https:// 开头' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[PhotoRestore] Request from openid=${openid}, bizCode=${bizCode}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, bizCode);
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, bizCode);
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Submit photo restoration to RunningHub with optional parameters
        const taskId = await submitPhotoRestore(imageUrl, {
            cnStrength: typeof cnStrength === 'number' ? cnStrength : undefined,
            outputSize: typeof outputSize === 'number' ? outputSize : undefined,
        });

        // Save to database
        const task = await createDbTask(openid, bizCode, taskId, imageUrl);
        console.log(`[PhotoRestore] Task created: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            message: '任务已提交，正在后台处理中，请稍后查询结果',
            data: {
                taskId: taskId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[PhotoRestore] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/photo/anime — 发起真人转动漫任务
// ============================================================
app.post('/api/photo/anime', async (req, res) => {
    try {
        const { code, bizCode, imageUrl, prompt } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (!imageUrl || typeof imageUrl !== 'string') {
            return res.status(400).json({ success: false, error: 'imageUrl 参数必填' });
        }

        // Validate imageUrl format
        if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
            return res.status(400).json({ success: false, error: 'imageUrl 格式无效，需以 http:// 或 https:// 开头' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[AnimeConvert] Request from openid=${openid}, bizCode=${bizCode}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, bizCode);
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, bizCode);
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Submit anime conversion to RunningHub with optional prompt
        const taskId = await submitAnimeConvert(imageUrl, {
            prompt: typeof prompt === 'string' ? prompt : undefined,
        });

        // Save to database
        const task = await createDbTask(openid, bizCode, taskId, imageUrl);
        console.log(`[AnimeConvert] Task created: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            message: '任务已提交，正在后台处理中，请稍后查询结果',
            data: {
                taskId: taskId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[AnimeConvert] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/photo/remove_watermark — 发起图片去水印任务
// ============================================================
app.post('/api/photo/remove_watermark', async (req, res) => {
    try {
        const { code, bizCode, imageUrl } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (bizCode !== 'remove_watermark') {
            return res.status(400).json({ success: false, error: 'bizCode 必须为 remove_watermark' });
        }
        if (!imageUrl || typeof imageUrl !== 'string') {
            return res.status(400).json({ success: false, error: 'imageUrl 参数必填' });
        }

        // Validate imageUrl format
        if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
            return res.status(400).json({ success: false, error: 'imageUrl 格式无效，需以 http:// 或 https:// 开头' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[WatermarkRemoval] Request from openid=${openid}, bizCode=${bizCode}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, bizCode);
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, bizCode);
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Submit watermark removal task to RunningHub
        const taskId = await submitWatermarkRemoval(imageUrl);

        // Save to database
        const task = await createDbTask(openid, bizCode, taskId, imageUrl);
        console.log(`[WatermarkRemoval] Task created: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            message: '任务已提交，正在后台处理中，请稍后查询结果',
            data: {
                taskId: taskId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[WatermarkRemoval] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/photo/text_to_image — 发起全能文生图任务
// ============================================================
app.post('/api/photo/text_to_image', async (req, res) => {
    try {
        const { code, bizCode, prompt, aspectRatio, resolution, seed, skipError } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (bizCode !== 'text_to_image') {
            return res.status(400).json({ success: false, error: 'bizCode 必须为 text_to_image' });
        }
        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ success: false, error: 'prompt 参数必填且必须为非空字符串' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[TextToImage] Request from openid=${openid}, bizCode=${bizCode}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, 'text_to_image');
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'text_to_image');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Submit text-to-image task to RunningHub with optional parameters
        const taskId = await submitTextToImage({
            prompt,
            aspectRatio: typeof aspectRatio === 'string' ? aspectRatio : undefined,
            resolution: typeof resolution === 'string' ? resolution : undefined,
            seed: typeof seed === 'number' ? seed : undefined,
            skipError: typeof skipError === 'boolean' ? skipError : undefined,
        });

        // Save to database, storing the prompt text in input_image_url field
        const task = await createDbTask(openid, bizCode, taskId, prompt);
        console.log(`[TextToImage] Task created: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            message: '任务已提交，正在后台处理中，请稍后查询结果',
            data: {
                taskId: taskId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[TextToImage] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================================
// API: POST /api/voice/clone — 发起语音克隆任务
// ============================================================
app.post('/api/voice/clone', async (req, res) => {
    try {
        const {
            code,
            bizCode,
            audioUrl,
            text,
            emotion,
            topK,
            topP,
            temperature,
            numBeams,
            maxMelTokens,
            maxTextTokensPerSentence,
            emoAlpha,
            useEmoText,
            useRandom,
        } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (bizCode !== 'voice_clone') {
            return res.status(400).json({ success: false, error: 'bizCode 必须为 voice_clone' });
        }
        if (!audioUrl || typeof audioUrl !== 'string') {
            return res.status(400).json({ success: false, error: 'audioUrl 参数必填' });
        }
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ success: false, error: 'text 参数必填' });
        }

        // Validate audioUrl format
        if (!audioUrl.startsWith('http://') && !audioUrl.startsWith('https://')) {
            return res.status(400).json({ success: false, error: 'audioUrl 格式无效，需以 http:// 或 https:// 开头' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[VoiceClone] Request from openid=${openid}, bizCode=${bizCode}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, 'voice_clone');
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'voice_clone');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Submit voice clone to RunningHub with optional parameters
        const taskId = await submitVoiceClone(audioUrl, text, {
            emotion: typeof emotion === 'string' ? emotion : undefined,
            topK: typeof topK === 'number' ? topK : undefined,
            topP: typeof topP === 'number' ? topP : undefined,
            temperature: typeof temperature === 'number' ? temperature : undefined,
            numBeams: typeof numBeams === 'number' ? numBeams : undefined,
            maxMelTokens: typeof maxMelTokens === 'number' ? maxMelTokens : undefined,
            maxTextTokensPerSentence: typeof maxTextTokensPerSentence === 'number' ? maxTextTokensPerSentence : undefined,
            emoAlpha: typeof emoAlpha === 'number' ? emoAlpha : undefined,
            useEmoText: typeof useEmoText === 'boolean' ? useEmoText : undefined,
            useRandom: typeof useRandom === 'boolean' ? useRandom : undefined,
        });

        // Save to database
        const task = await createDbTask(openid, bizCode, taskId, audioUrl);
        console.log(`[VoiceClone] Task created: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            message: '任务已提交，正在后台处理中，请稍后查询结果',
            data: {
                taskId: taskId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[VoiceClone] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/voice/text_to_speech — 发起文本转语音任务
// ============================================================
app.post('/api/voice/text_to_speech', async (req, res) => {
    try {
        const {
            code,
            bizCode,
            text,
            voiceDescription,
            language,
        } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (bizCode !== 'text_to_speech') {
            return res.status(400).json({ success: false, error: 'bizCode 必须为 text_to_speech' });
        }
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ success: false, error: 'text 参数必填且必须为非空字符串' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[TextToSpeech] Request from openid=${openid}, bizCode=${bizCode}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, 'text_to_speech');
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'text_to_speech');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Submit text-to-speech to RunningHub with optional parameters
        const taskId = await submitTextToSpeech({
            text,
            voiceDescription: typeof voiceDescription === 'string' ? voiceDescription : undefined,
            language: typeof language === 'string' ? language : undefined,
        });

        // Save to database
        const task = await createDbTask(openid, bizCode, taskId, text);
        console.log(`[TextToSpeech] Task created: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            message: '任务已提交，正在后台处理中，请稍后查询结果',
            data: {
                taskId: taskId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[TextToSpeech] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/video/image_to_video — 发起图生视频任务 (Wan2.2)
// ============================================================
app.post('/api/video/image_to_video', async (req, res) => {
    try {
        const {
            code,
            bizCode,
            imageUrl,
            positivePrompt,
            negativePrompt,
            maxResolution,
            duration,
            frameRate,
            seed,
        } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (bizCode !== 'image_to_video') {
            return res.status(400).json({ success: false, error: 'bizCode 必须为 image_to_video' });
        }
        if (!imageUrl || typeof imageUrl !== 'string') {
            return res.status(400).json({ success: false, error: 'imageUrl 参数必填' });
        }

        // Validate imageUrl format
        if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
            return res.status(400).json({ success: false, error: 'imageUrl 格式无效，需以 http:// 或 https:// 开头' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[ImageToVideo] Request from openid=${openid}, bizCode=${bizCode}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, 'image_to_video');
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'image_to_video');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Submit image-to-video task to RunningHub with optional parameters
        const taskId = await submitImageToVideo(imageUrl, {
            positivePrompt: typeof positivePrompt === 'string' ? positivePrompt : undefined,
            negativePrompt: typeof negativePrompt === 'string' ? negativePrompt : undefined,
            maxResolution: typeof maxResolution === 'number' ? maxResolution : undefined,
            duration: typeof duration === 'number' ? duration : undefined,
            frameRate: typeof frameRate === 'number' ? frameRate : undefined,
            seed: typeof seed === 'number' ? seed : undefined,
        });

        // Save to database
        const task = await createDbTask(openid, bizCode, taskId, imageUrl);
        console.log(`[ImageToVideo] Task created: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            message: '任务已提交，正在后台处理中，请稍后查询结果',
            data: {
                taskId: taskId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[ImageToVideo] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/wechat/transcript/submit — 发起视频文案提取

// ============================================================
app.post('/api/wechat/transcript/submit', async (req, res) => {
    try {
        const { code, url } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ success: false, error: 'url 参数必填（抖音视频链接）' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[TranscriptSubmit] Request from openid=${openid}, url=${url}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, 'video_transcript');
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'video_transcript');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // 1. Parse Douyin URL to get normalized video link
        let parsedResult;
        try {
            parsedResult = await getDouyinVideoUrl(url);
        } catch (err: any) {
            console.error('[TranscriptSubmit] Parse Douyin URL failed:', err.message);
            return res.status(400).json({
                success: false,
                error: '解析链接失败：' + err.message,
            });
        }

        // 2. Generate a unique task ID for the record
        const taskId = `transcript_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

        // 3. Write a SUCCESS record directly to the database (synchronous parsing)
        const task = await createDbTask(openid, 'video_transcript', taskId, url);
        await updateTaskByTaskId(taskId, 'SUCCESS', {
            url: parsedResult.videoSrc,
            cover: parsedResult.coverSrc,
            desc: parsedResult.desc,
        }, parsedResult.videoSrc, null);

        console.log(`[TranscriptSubmit] Task completed immediately: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            data: {
                taskId: taskId,
                url: parsedResult.videoSrc,
                cover: parsedResult.coverSrc,
                desc: parsedResult.desc,
            },
        });
    } catch (error: any) {
        console.error('[TranscriptSubmit] Unhandled error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/novel/to_script — 发起小说改漫剧剧本任务
// ============================================================
app.post('/api/novel/to_script', async (req, res) => {
    try {
        const {
            code,
            bizCode,
            novelText,
            temperature,
            seed,
        } = req.body;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }
        if (bizCode !== 'novel_to_script') {
            return res.status(400).json({ success: false, error: 'bizCode 必须为 novel_to_script' });
        }
        if (!novelText || typeof novelText !== 'string') {
            return res.status(400).json({ success: false, error: 'novelText 参数必填且必须为非空字符串' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[NovelToScript] Request from openid=${openid}, bizCode=${bizCode}`);

        // Check for active tasks — concurrent control
        const active = await hasActiveTask(openid, 'novel_to_script');
        if (active) {
            return res.status(409).json({
                success: false,
                error: '您有一个正在处理中的任务，请等待处理完成后再次提交',
            });
        }

        // Check daily quota
        const quotaError = await checkDailyQuota(openid, 'novel_to_script');
        if (quotaError) {
            return res.status(429).json({ success: false, error: quotaError });
        }

        // Submit novel-to-script task to RunningHub with optional parameters
        const taskId = await submitNovelToScript({
            novelText,
            temperature: typeof temperature === 'number' ? temperature : undefined,
            seed: typeof seed === 'number' ? seed : undefined,
        });

        // Save to database, storing the novel text in input_image_url field
        const task = await createDbTask(openid, bizCode, taskId, novelText);
        console.log(`[NovelToScript] Task created: id=${task.id}, taskId=${taskId}`);

        res.json({
            success: true,
            message: '任务已提交，正在后台处理中，请稍后查询结果',
            data: {
                taskId: taskId,
                status: 'PENDING',
            },
        });
    } catch (error: any) {
        console.error('[NovelToScript] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '提交任务失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/webhook/runninghub — 接收 RunningHub 回调
// ============================================================
app.post('/api/webhook/runninghub', async (req, res) => {
    try {
        const body = req.body;
        console.log('[Webhook] Received callback:', JSON.stringify(body).substring(0, 500));

        // Extract taskId from the callback payload
        const taskId = body.taskId || body.data?.taskId || body.task_id;
        if (!taskId) {
            console.error('[Webhook] No taskId found in callback body');
            return res.status(400).json({ error: 'taskId is required' });
        }

        // Parse eventData if it's a JSON string (RunningHub's actual format)
        let parsedEventData: any = null;
        if (body.eventData && typeof body.eventData === 'string') {
            try {
                parsedEventData = JSON.parse(body.eventData);
                console.log('[Webhook] Parsed eventData:', JSON.stringify(parsedEventData).substring(0, 300));
            } catch (e) {
                console.warn('[Webhook] Failed to parse eventData:', body.eventData.substring(0, 200));
            }
        } else if (body.eventData && typeof body.eventData === 'object') {
            parsedEventData = body.eventData;
        }

        // Determine status
        // RunningHub uses "event" field: TASK_END = success, TASK_FAIL = failed
        const event = body.event || '';
        const rawStatus = body.status || body.taskStatus || body.data?.taskStatus || '';

        const isSuccess = event === 'TASK_END' ||
                          rawStatus === 'success' || rawStatus === 'SUCCESS' ||
                          rawStatus === 'completed' || rawStatus === 'COMPLETED' ||
                          (parsedEventData?.code === 0 && parsedEventData?.msg === 'success');
        const isFailed = event === 'TASK_FAIL' ||
                         rawStatus === 'failed' || rawStatus === 'FAILED' ||
                         rawStatus === 'error' || rawStatus === 'ERROR';
        const status = isSuccess ? 'SUCCESS' : isFailed ? 'FAILED' : 'RUNNING';

        // Extract output image URL from multiple possible locations
        let outputImageUrl: string | null = null;

        // 1. Try parsedEventData.results array (RunningHub's V2 format)
        if (parsedEventData?.results && Array.isArray(parsedEventData.results)) {
            for (const item of parsedEventData.results) {
                if (item.url) {
                    outputImageUrl = item.url;
                    break;
                }
            }
        }

        // 2. Try body.results array (V2 root results)
        if (!outputImageUrl && body.results && Array.isArray(body.results)) {
            for (const item of body.results) {
                const url = item.url || item.fileUrl;
                if (url) {
                    outputImageUrl = url;
                    break;
                }
            }
        }

        // 3. Try parsedEventData.data array (RunningHub's V1 format)
        if (!outputImageUrl && parsedEventData?.data && Array.isArray(parsedEventData.data)) {
            for (const item of parsedEventData.data) {
                if (item.fileUrl) {
                    outputImageUrl = item.fileUrl;
                    break;
                }
            }
        }

        // 4. Try body.data or body.outputs (legacy formats)
        if (!outputImageUrl) {
            const outputs = body.data || body.outputs || body.output;
            if (Array.isArray(outputs)) {
                for (const item of outputs) {
                    const url = item.fileUrl || item.output?.fileUrl || item.file_url || item.url;
                    if (url) {
                        outputImageUrl = url;
                        break;
                    }
                }
            } else if (outputs && typeof outputs === 'object') {
                outputImageUrl = outputs.fileUrl || outputs.file_url || outputs.url || outputs.output?.fileUrl || null;
            }
        }

        // Extract error message for failed tasks
        const errorMessage = isFailed
            ? (parsedEventData?.msg || body.message || body.msg || body.error || '任务处理失败')
            : null;

        // Update database
        const updatedTask = await updateTaskByTaskId(taskId, status, body, outputImageUrl, errorMessage);

        if (updatedTask) {
            console.log(`[Webhook] Task ${taskId} updated to ${status}, outputUrl=${outputImageUrl?.substring(0, 80)}`);
        } else {
            console.warn(`[Webhook] Task ${taskId} not found in database`);
        }

        // Always return 200 to acknowledge receipt
        res.json({ success: true, message: 'Webhook received' });
    } catch (error: any) {
        console.error('[Webhook] Error processing callback:', error.message);
        // Still return 200 to prevent RunningHub from retrying
        res.json({ success: true, message: 'Webhook received (with errors)' });
    }
});

// ============================================================
// API: GET /api/photo/result — 查询任务处理结果
// ============================================================
app.get('/api/photo/result', async (req, res) => {
    try {
        const { code, bizCode } = req.query;

        // Validate required fields
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }
        if (!bizCode || typeof bizCode !== 'string') {
            return res.status(400).json({ success: false, error: 'bizCode 参数必填' });
        }

        // Exchange code for openid
        let openid: string;
        try {
            const wxData = await getOpenIdFromCode(code);
            openid = wxData.openid;
        } catch (err: any) {
            return res.status(400).json({ success: false, error: `微信验证失败：${err.message}`, errcode: err.errcode });
        }

        console.log(`[Result] Query from openid=${openid}, bizCode=${bizCode}`);

        // Get latest task
        const task = await getLatestTask(openid, bizCode);

        if (!task) {
            return res.json({
                success: true,
                data: {
                    status: 'NONE',
                    message: '没有找到相关任务记录',
                },
            });
        }

        // Build response based on task status
        const responseData: any = {
            status: task.status,
            taskId: task.task_id,
            createdAt: task.created_at,
            updatedAt: task.updated_at,
        };

        switch (task.status) {
            case 'PENDING':
                responseData.message = '任务已提交，正在排队中...';
                break;
            case 'RUNNING':
                responseData.message = '任务正在处理中，请稍后再查询';
                break;
            case 'SUCCESS':
                responseData.message = '任务处理完成';
                if (bizCode === 'media_sec_check') {
                    responseData.message = '检测完成，内容合规';
                }
                if (bizCode === 'voice_clone' || bizCode === 'text_to_speech') {
                    responseData.outputAudioUrl = task.output_image_url;
                    responseData.inputAudioUrl = task.input_image_url;
                }
                if (bizCode === 'text_to_speech') {
                    responseData.text = task.input_image_url;
                }
                if (bizCode === 'text_to_image') {
                    responseData.prompt = task.input_image_url;
                }
                if (bizCode === 'image_to_video') {
                    responseData.outputVideoUrl = task.output_image_url;
                }
                if (bizCode === 'novel_to_script') {
                    responseData.novelText = task.input_image_url;
                    responseData.outputFileUrl = task.output_image_url;
                }
                responseData.outputImageUrl = task.output_image_url;
                responseData.inputImageUrl = task.input_image_url;
                break;
            case 'FAILED':
                responseData.message = task.error_message || '任务处理失败';
                break;
            default:
                responseData.message = '未知状态';
        }

        res.json({
            success: true,
            data: responseData,
        });
    } catch (error: any) {
        console.error('[Result] Error:', error.message);
        res.status(500).json({
            success: false,
            error: '查询失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: GET /api/wechat/transcript/result — 查询视频文案提取结果
// ============================================================
app.get('/api/wechat/transcript/result', async (req, res) => {
    try {
        const { taskId } = req.query;

        if (!taskId || typeof taskId !== 'string') {
            return res.status(400).json({ success: false, error: 'taskId 参数必填' });
        }

        console.log(`[TranscriptResult] Query for taskId=${taskId}`);

        // 1. Fetch task from our database first
        let task = await getTaskByTaskId(taskId);

        if (!task) {
            // Fallback: If not in DB, try to query VoiceText AI directly
            console.log(`[TranscriptResult] Task ${taskId} not found in DB. Trying direct VoiceText query...`);
            const apiKey = process.env.VOICETEXT_API_KEY || 'vtt_8d64f6c85f80d101f295fd587ef0f1a46e74105ed84ea529';
            try {
                const response = await axios.get(`https://video.kkdmx.com/openapi/v1/transcript/${taskId}`, {
                    headers: { 'X-API-Key': apiKey },
                    timeout: 15000,
                });
                
                if (response.data && response.data.success) {
                    const data = response.data.data;
                    const statusMap: Record<string, string> = {
                        'completed': 'SUCCESS',
                        'failed': 'FAILED',
                        'processing': 'RUNNING',
                    };
                    const status = statusMap[data.status] || 'RUNNING';
                    
                    const responseData: any = {
                        status: status,
                        taskId: taskId,
                        message: status === 'SUCCESS' ? '任务处理完成' : status === 'FAILED' ? (data.error_message || '任务处理失败') : '任务正在处理中，请稍后再查询',
                    };
                    if (status === 'SUCCESS') {
                        responseData.text = data.text;
                        responseData.duration = data.duration;
                    }
                    return res.json({
                        success: true,
                        data: responseData,
                    });
                } else {
                    return res.status(404).json({
                        success: false,
                        error: '没有找到相关任务记录',
                    });
                }
            } catch (err: any) {
                console.error('[TranscriptResult] Direct VoiceText query failed:', err.message);
                return res.status(404).json({
                    success: false,
                    error: '没有找到相关任务记录',
                });
            }
        }

        // 2. If task status is already SUCCESS or FAILED, return the stored result immediately
        if (task.status === 'SUCCESS' || task.status === 'FAILED') {
            const responseData: any = {
                status: task.status,
                taskId: task.task_id,
                createdAt: task.created_at,
                updatedAt: task.updated_at,
                message: task.status === 'SUCCESS' ? '任务处理完成' : (task.error_message || '任务处理失败'),
            };
            if (task.status === 'SUCCESS') {
                responseData.text = task.output_data?.text || '';
                responseData.duration = task.output_data?.duration || 0;
            }
            return res.json({
                success: true,
                data: responseData,
            });
        }

        // 3. If status is PENDING or RUNNING, poll the third-party API
        console.log(`[TranscriptResult] Task ${taskId} is ${task.status} in DB. Polling VoiceText API...`);
        const apiKey = process.env.VOICETEXT_API_KEY || 'vtt_8d64f6c85f80d101f295fd587ef0f1a46e74105ed84ea529';
        
        try {
            const response = await axios.get(`https://video.kkdmx.com/openapi/v1/transcript/${taskId}`, {
                headers: { 'X-API-Key': apiKey },
                timeout: 15000,
            });

            if (response.data && response.data.success) {
                const data = response.data.data;
                let updatedStatus = task.status;
                let errorMessage: string | null = null;

                if (data.status === 'completed') {
                    updatedStatus = 'SUCCESS';
                } else if (data.status === 'failed') {
                    updatedStatus = 'FAILED';
                    errorMessage = data.error_message || '提取文案失败';
                } else if (data.status === 'processing') {
                    updatedStatus = 'RUNNING';
                }

                // Update database
                const updatedTask = await updateTaskByTaskId(taskId, updatedStatus, data, null, errorMessage);
                const currentTask = updatedTask || task;

                const responseData: any = {
                    status: currentTask.status,
                    taskId: currentTask.task_id,
                    createdAt: currentTask.created_at,
                    updatedAt: currentTask.updated_at,
                    message: currentTask.status === 'SUCCESS' ? '任务处理完成' : currentTask.status === 'FAILED' ? (currentTask.error_message || '任务处理失败') : '任务正在处理中，请稍后再查询',
                };
                if (currentTask.status === 'SUCCESS') {
                    responseData.text = currentTask.output_data?.text || '';
                    responseData.duration = currentTask.output_data?.duration || 0;
                }

                res.json({
                    success: true,
                    data: responseData,
                });
            } else {
                console.warn('[TranscriptResult] VoiceText API returned success=false:', response.data);
                res.json({
                    success: true,
                    data: {
                        status: task.status,
                        taskId: task.task_id,
                        createdAt: task.created_at,
                        updatedAt: task.updated_at,
                        message: '查询中...',
                    },
                });
            }
        } catch (err: any) {
            console.error('[TranscriptResult] Polling VoiceText API error:', err.message);
            // On API query error, fallback to returning the stored DB status
            res.json({
                success: true,
                data: {
                    status: task.status,
                    taskId: task.task_id,
                    createdAt: task.created_at,
                    updatedAt: task.updated_at,
                    message: '查询服务暂时不可用，返回本地状态：' + (task.status === 'PENDING' ? '排队中' : '处理中'),
                },
            });
        }
    } catch (error: any) {
        console.error('[TranscriptResult] Unhandled error:', error.message);
        res.status(500).json({
            success: false,
            error: '查询失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// API: POST /api/wechat/image_hosting/upload — 图床上传（微信验证）
// ============================================================

/** Hardcoded WeChat credentials for image hosting verification */
const IMAGE_HOSTING_WECHAT_APPID = 'wx3406fa15d1bb4861';
const IMAGE_HOSTING_WECHAT_SECRET = 'b9cb99fc10b10d83e94151b5ad14f5e1';

/** Hardcoded HelloImg API token */
const HELLOIMG_API_TOKEN = '1692|4eamVMuvLawp5tAUdHWZhAtkHzFBVvuaFNfpfcV6';
const HELLOIMG_API_BASE = 'https://www.helloimg.com/api/v1';

/**
 * Exchange WeChat code for openid using hardcoded AppID/AppSecret (image hosting specific).
 */
async function getOpenIdForImageHosting(code: string): Promise<{ openid: string }> {
    console.log('[ImageHosting] Exchanging code for openid...');

    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
        params: {
            appid: IMAGE_HOSTING_WECHAT_APPID,
            secret: IMAGE_HOSTING_WECHAT_SECRET,
            js_code: code,
            grant_type: 'authorization_code',
        },
        timeout: 10000,
    });

    const wxData = wxRes.data;
    console.log('[ImageHosting] WeChat response:', JSON.stringify({
        openid: wxData.openid ? '***' : undefined,
        errcode: wxData.errcode,
        errmsg: wxData.errmsg,
    }));

    if (wxData.errcode && wxData.errcode !== 0) {
        const errorMessages: Record<number, string> = {
            40029: 'code 无效或已过期，请重新调用 wx.login',
            45011: '请求频率限制，请稍后再试',
            40226: '高风险等级用户，小程序登录拦截',
            [-1]: '微信系统繁忙，请稍后再试',
        };
        const msg = errorMessages[wxData.errcode] || wxData.errmsg || '微信登录失败';
        const err = new Error(msg) as any;
        err.errcode = wxData.errcode;
        throw err;
    }

    if (!wxData.openid) {
        throw new Error('微信登录异常：未返回 openid');
    }

    return { openid: wxData.openid };
}

app.post('/api/wechat/image_hosting/upload', upload.single('file'), async (req, res) => {
    try {
        // 1. Validate parameters
        const code = req.body?.code;
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, error: 'code 参数必填' });
        }

        const file = req.file;
        if (!file) {
            return res.status(400).json({ success: false, error: '请上传图片文件（字段名: file）' });
        }

        // Validate image mime type
        const allowedImageMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
        if (!allowedImageMimes.includes(file.mimetype)) {
            return res.status(400).json({ success: false, error: `不支持的图片类型: ${file.mimetype}，仅支持 JPG/PNG/WEBP/GIF/AVIF` });
        }

        // 2. Verify WeChat code -> openid
        let openid: string;
        try {
            const wxData = await getOpenIdForImageHosting(code);
            openid = wxData.openid;
        } catch (err: any) {
            console.error('[ImageHosting] WeChat verification failed:', err.message);
            return res.status(400).json({
                success: false,
                error: `微信验证失败：${err.message}`,
                errcode: err.errcode,
            });
        }

        console.log(`[ImageHosting] Verified openid=${openid}, uploading image: ${file.originalname} (${file.size} bytes)`);

        // 3. Upload image to HelloImg
        const formData = new FormData();
        formData.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
        });

        const helloImgRes = await axios.post(`${HELLOIMG_API_BASE}/upload`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${HELLOIMG_API_TOKEN}`,
                'Accept': 'application/json',
            },
            timeout: 30000,
            maxContentLength: 20 * 1024 * 1024,
            maxBodyLength: 20 * 1024 * 1024,
        });

        const imgData = helloImgRes.data;
        console.log('[ImageHosting] HelloImg response status:', imgData.status);

        if (!imgData.status) {
            console.error('[ImageHosting] HelloImg upload failed:', JSON.stringify(imgData));
            return res.status(500).json({
                success: false,
                error: `图床上传失败：${imgData.message || '未知错误'}`,
            });
        }

        // 4. Return success with image info
        const imageInfo = imgData.data || {};
        res.json({
            success: true,
            message: '图片上传成功',
            data: {
                url: imageInfo.links?.url || '',
                thumbnailUrl: imageInfo.links?.thumbnail_url || '',
                deleteUrl: imageInfo.links?.delete_url || '',
                key: imageInfo.key || '',
                name: imageInfo.name || '',
                pathname: imageInfo.pathname || '',
                originName: imageInfo.origin_name || '',
                size: imageInfo.size || 0,
                mimetype: imageInfo.mimetype || '',
                extension: imageInfo.extension || '',
                md5: imageInfo.md5 || '',
                sha1: imageInfo.sha1 || '',
                links: imageInfo.links || {},
            },
        });
    } catch (error: any) {
        console.error('[ImageHosting] Unhandled error:', error.message);
        if (error.response) {
            console.error('[ImageHosting] Response status:', error.response.status);
            console.error('[ImageHosting] Response data:', JSON.stringify(error.response.data));
        }
        res.status(500).json({
            success: false,
            error: '图片上传失败：' + (error.message || '未知错误'),
        });
    }
});

// ============================================================
// Serve frontend
// ============================================================
if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
} else {
    const startVite = async () => {
        const { createServer } = await import('vite');
        const vite = await createServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    };
    startVite();
}

// ============================================================
// Start Server
// ============================================================
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);

    // Initialize database (non-blocking, won't crash if DB is unavailable)
    try {
        await initDatabase();
        // Clean up stale tasks on startup
        const cleaned = await cleanStaleTasks();
        if (cleaned > 0) {
            console.log(`[Startup] Cleaned ${cleaned} stale task(s)`);
        }
    } catch (err: any) {
        console.warn('[Startup] Database initialization skipped:', err.message);
    }
});
