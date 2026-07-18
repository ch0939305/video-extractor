// Vercel Serverless Function — 影片文案提取 API
// 支援：TikTok / 抖音 / B站 / 小紅書 / YouTube

const axios = require('axios');
const https = require('https');

const agent = new https.Agent({ keepAlive: true, timeout: 10000 });

async function get(url, opts = {}) {
  return axios.get(url, {
    httpsAgent: agent, timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      ...opts.headers
    },
    ...opts
  });
}

async function resolveShortUrl(url) {
  try {
    const resp = await axios.get(url, {
      maxRedirects: 0, validateStatus: s => s >= 200 && s < 400,
      httpsAgent: agent, timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' }
    });
    return resp.headers.location || url;
  } catch { return url; }
}

// 1. TikTok OEmbed（官方，最穩定）
async function methodTikTokOEmbed(url) {
  const resolved = await resolveShortUrl(url);
  const tid = resolved.match(/video\/(\d+)/)?.[1];
  if (!tid) return null;
  try {
    const r = await get(`https://www.tiktok.com/oembed?url=https://www.tiktok.com/@i/video/${tid}`);
    if (r.data?.description) return r.data.description;
    if (r.data?.title) return r.data.title;
  } catch {}
  return null;
}

// 2. tikwm API（支援 TikTok + 抖音）
async function methodTikwm(url) {
  const resolved = await resolveShortUrl(url);
  try {
    const r = await axios.get('https://www.tikwm.com/api/', {
      params: { url: resolved },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      httpsAgent: agent, timeout: 8000
    });
    if (r.data?.code === 0) {
      return r.data.data?.title || r.data.data?.desc || null;
    }
  } catch {}
  return null;
}

// 3. 抖音 RENDER_DATA 解析
async function methodDouyinPage(url) {
  const resolved = url.includes('douyin.com/video/') ? url : await resolveShortUrl(url);
  let html = '';
  try {
    const resp = await get(resolved);
    html = resp.data;
  } catch {
    try {
      const resp2 = await get(resolved.replace('www.douyin.com', 'm.douyin.com'),
        { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' } }
      );
      html = resp2.data;
    } catch { return null; }
  }

  const rdm = html.match(/<script id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (rdm) {
    try {
      const decoded = Buffer.from(rdm[1], 'base64').toString('utf8');
      const dm = decoded.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (dm) return dm[1].replace(/\\u0026/g, '&').replace(/\\n/g, '\n');
    } catch {}
  }

  const srm = html.match(/window\.__SSR_RENDER_DATA__\s*=\s*({.+?});?<\/script>/);
  if (srm) {
    try {
      const d = JSON.parse(srm[1]);
      const desc = d?.app?.videoInfoRes?.item_list?.[0]?.desc
        || d?.videoInfoRes?.item_list?.[0]?.desc
        || d?.app?.aweme?.detail?.desc;
      if (desc) return desc;
    } catch {}
  }

  return null;
}

// 4. YouTube OEmbed / OG
async function methodYouTube(url) {
  try {
    const r = await get(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (r.data?.title) return r.data.title;
    if (r.data?.description) return r.data.description;
  } catch {}
  return null;
}

// 5. 通用 OG Meta
async function methodOpenGraph(url) {
  try {
    const resolved = await resolveShortUrl(url);
    const r = await get(resolved, { timeout: 6000 });
    const html = r.data;
    const patterns = [
      /<meta\s+name="description"\s+content="([^"]*)"/i,
      /<meta\s+property="og:description"\s+content="([^"]*)"/i,
      /<meta\s+property="og:title"\s+content="([^"]*)"/i
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) return m[1].replace(/&amp;/g, '&').replace(/&#?\w+;/g, '');
    }
  } catch {}
  return null;
}

// 主處理
async function extractCaption(url) {
  let caption = null;
  let platform = 'unknown';
  const u = url.toLowerCase();

  if (u.includes('tiktok')) {
    platform = 'TikTok';
    caption = await methodTikTokOEmbed(url);
    if (!caption) caption = await methodTikwm(url);
    if (!caption) caption = await methodOpenGraph(url);
  } else if (u.includes('douyin') || u.includes('dy')) {
    platform = '抖音/Douyin';
    caption = await methodDouyinPage(url);
    if (!caption) caption = await methodTikwm(url);
    if (!caption) caption = await methodOpenGraph(url);
  } else if (u.includes('youtube') || u.includes('youtu.be')) {
    platform = 'YouTube';
    caption = await methodYouTube(url);
    if (!caption) caption = await methodOpenGraph(url);
  } else if (u.includes('bilibili') || u.includes('b23')) {
    platform = 'B站/Bilibili';
    caption = await methodOpenGraph(url);
  } else if (u.includes('xiaohongshu') || u.includes('xhslink')) {
    platform = '小紅書';
    caption = await methodOpenGraph(url);
  } else {
    platform = '其他';
    caption = await methodOpenGraph(url);
    if (!caption) caption = await methodTikwm(url);
  }

  return { platform, caption };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.query.url || req.body?.url;
  if (!url) return res.status(400).json({ success: false, error: '請提供影片網址' });

  try {
    const result = await extractCaption(url);
    res.json({
      success: !!result.caption,
      platform: result.platform,
      caption: result.caption || null,
      error: result.caption ? null : '無法自動提取，這些平台有反爬機制保護',
      url
    });
  } catch (err) {
    res.status(500).json({ success: false, error: '伺服器錯誤：' + err.message });
  }
};
