import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
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
        console.log('Processing URL:', targetUrl);
        // Follow redirects to resolve short links (v.douyin.com)
        const response = await axios.get(targetUrl, {
            maxRedirects: 5,
            headers: { 'User-Agent': MOBILE_UA },
        });
        const finalUrl = response.request?.res?.responseUrl ||
            response.request?.responseURL ||
            targetUrl;
        console.log('Final URL:', finalUrl);
        // Extract Video ID from final URL
        const videoIdMatch = finalUrl.match(/\/video\/(\d+)/);
        const videoId = videoIdMatch ? videoIdMatch[1] : null;
        const html = response.data;
        const $ = cheerio.load(html);
        let videoSrc = '';
        let coverSrc = '';
        let desc = '';
        // ------ Strategy 1: Parse RENDER_DATA script tag ------
        const renderDataScript = $('#RENDER_DATA');
        if (renderDataScript.length > 0) {
            try {
                const decoded = decodeURIComponent(renderDataScript.html() || '');
                const renderData = JSON.parse(decoded);
                const findVideoInfo = (obj) => {
                    if (!obj || typeof obj !== 'object')
                        return;
                    if (obj.video && obj.video.playApi) {
                        videoSrc = 'https:' + obj.video.playApi;
                        desc = obj.desc || desc;
                        if (obj.video.cover && obj.video.cover.urlList) {
                            coverSrc = obj.video.cover.urlList[0] || '';
                        }
                        return;
                    }
                    if (obj.video && obj.video.play_addr && obj.video.play_addr.url_list) {
                        videoSrc = obj.video.play_addr.url_list[0] || '';
                        videoSrc = videoSrc.replace('playwm', 'play');
                        desc = obj.desc || desc;
                        if (obj.video.cover && obj.video.cover.url_list) {
                            coverSrc = obj.video.cover.url_list[0] || '';
                        }
                        return;
                    }
                    for (const key of Object.keys(obj)) {
                        findVideoInfo(obj[key]);
                        if (videoSrc)
                            return;
                    }
                };
                findVideoInfo(renderData);
            }
            catch (e) {
                console.error('Error parsing RENDER_DATA', e);
            }
        }
        // ------ Strategy 2: Search script tags for playAddr ------
        if (!videoSrc) {
            $('script').each((_i, el) => {
                const content = $(el).html() || '';
                if (content.includes('playAddr')) {
                    const matches = content.match(/"playAddr":\s*(\[\{.*?\}\])/);
                    if (matches && matches[1]) {
                        try {
                            const json = JSON.parse(matches[1]);
                            const src = json[0]?.src;
                            if (src) {
                                videoSrc = src.startsWith('//') ? 'https:' + src : src;
                                videoSrc = videoSrc.replace('playwm', 'play');
                            }
                        }
                        catch (e) {
                            console.error('Error parsing playAddr JSON', e);
                        }
                    }
                }
            });
        }
        // ------ Strategy 3: Old API fallback ------
        if (!videoSrc && videoId) {
            try {
                const apiRes = await axios.get(`https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
                    },
                });
                const itemList = apiRes.data.item_list;
                if (itemList && itemList.length > 0) {
                    const item = itemList[0];
                    videoSrc = item.video.play_addr.url_list[0];
                    videoSrc = videoSrc.replace('playwm', 'play');
                    coverSrc = item.video.cover.url_list[0];
                    desc = item.desc;
                }
            }
            catch (e) {
                console.error('API fallback failed', e);
            }
        }
        // ------ Strategy 4: Generic mp4 regex ------
        if (!videoSrc) {
            const mp4Match = html.match(/https?:\/\/[^"']+\.mp4/);
            if (mp4Match) {
                videoSrc = mp4Match[0];
            }
        }
        // If all strategies fail, return a demo video
        if (!videoSrc) {
            console.log('Parsing failed, returning demo data for UI verification.');
            return res.json({
                success: true,
                data: {
                    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
                    cover: 'https://picsum.photos/seed/douyin/400/600',
                    desc: '解析失败（服务器 IP 可能被限制）。展示示例视频供预览。',
                    isDemo: true,
                },
            });
        }
        res.json({
            success: true,
            data: {
                url: videoSrc,
                cover: coverSrc,
                desc: desc,
            },
        });
    }
    catch (error) {
        console.error('Parse error:', error);
        res.status(500).json({ error: '解析视频失败，请检查链接是否正确' });
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
    try {
        const response = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': MOBILE_UA,
                Referer: 'https://www.douyin.com/',
            },
            timeout: 60000,
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
    }
    catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({ error: '视频下载失败，请稍后重试' });
    }
});
// ============================================================
// Serve frontend
// ============================================================
if (process.env.NODE_ENV === 'production') {
    // Production: serve static files from dist/
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
}
else {
    // Development: use Vite dev server as middleware
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
