import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import crypto from 'crypto';

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

// ============================================================
// API: POST /api/parse — 解析抖音视频链接
// ============================================================
app.post('/api/parse', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

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
            return res.status(400).json({ error: '无法从链接中提取视频ID，请检查链接格式' });
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
            return res.json({
                success: false,
                error: '解析失败，所有策略均无法获取视频地址。可能原因：1) 视频已删除 2) 服务器IP被限制 3) 链接格式不支持',
            });
        }

        // Normalize domains for accessibility from overseas servers
        videoSrc = normalizeVideoUrl(videoSrc);
        console.log('[Parse] Final video URL (normalized):', videoSrc.substring(0, 120) + '...');

        res.json({
            success: true,
            data: {
                url: videoSrc,
                cover: coverSrc,
                desc: desc || '抖音视频',
            },
        });
    } catch (error: any) {
        console.error('[Parse] Unhandled error:', error.message);
        res.status(500).json({ error: '解析视频失败：' + (error.message || '未知错误') });
    }
});

// ============================================================
// API: GET /api/proxy — 流式代理视频下载（无大小限制）
// ============================================================
app.get('/api/proxy', async (req, res) => {
    const { url } = req.query;

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
        res.setHeader('Content-Disposition', 'attachment; filename="douyin_video.mp4"');
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
