// Vercel Serverless Function — 影片文案提取 API
// 支援：抖音、TikTok、B站、小紅書

const axios = require('axios');
const https = require('https');

// 可重用 agent（keepalive）
const agent = new https.Agent({ keepAlive: true, timeout: 10000 });

async function get(url, opts = {}) {
  return axios.get(url, {
    httpsAgent: agent,
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      ...opts.headers
    },
    ...opts
  });
}

// 短網址還原
async function resolveShortUrl(url) {
  try {
    const resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: s => s >= 200 && s < 400,
      httpsAgent: agent,
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' }
    });
    return resp.headers.location || url;
  } catch { return url; }
}

// 從 HTML meta 抓描述
function extractMetaDesc(html) {
  const patterns = [
    /<meta\s+name="description"\s+content="([^"]*)"/i,
    /<meta\s+property="og:description"\s+content="([^"]*)"/i,
    /<meta\s+name="twitter:description"\s+content="([^"]*)"/i,
    /<meta\s+property="og:title"\s+content="([^"]*)"/i
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1].replace(/&amp;/g, '&').replace(/&#?\w+;/g, '');
  }
  return null;
}

// 方式一：直接抓抖音頁面 HTML → 找 RENDER_DATA / SSR
async function methodDouyinPage(url) {
  const resolved = url.includes('douyin.com/video/') ? url : await resolveShortUrl(url);
  let html = '';
  try {
    const resp = await get(resolved);
    html = resp.data;
  } catch {
    try {
      const resp2 = await axios.get(resolved.replace('www.douyin.com', 'm.douyin.com'), {
        httpsAgent: agent, timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' }
      });
      html = resp2.data;
    } catch { return null; }
  }

  // RENDER_DATA (base64)
  const rdm = html.match(/<script id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (rdm) {
    try {
      const decoded = Buffer.from(rdm[1], 'base64').toString('utf8');
      const dm = decoded.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (dm) return dm[1].replace(/\\u0026/g, '&').replace(/\\n/g, '\n');
    } catch {}
  }

  // SSR RENDER_DATA
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

  // Meta fallback
  const meta = extractMetaDesc(html);
  if (meta) return meta;

  return null;
}

// 方式二：第三方 API
async function methodThirdParty(url) {
  const resolved = url.match(/douyin\.com\/video\/(\d+)/)
    ? url
    : await resolveShortUrl(url);

  // 2a. TikTok OEmbed
  const tid = resolved.match(/video\/(\d+)/)?.[1];
  if (tid) {
    try {
      const r = await get(`https://www.tiktok.com/oembed?url=https://www.tiktok.com/@user/video/${tid}`);
      if (r.data?.description) return r.data.description;
      if (r.data?.title) return r.data.title;
    } catch {}
  }

  // 2b. tikwm API
  try {
    const r = await axios.get('https://www.tikwm.com/api/', {
      params: { url: resolved },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 6000
    });
    if (r.data?.code === 0) {
      return r.data.data?.title || r.data.data?.desc || null;
    }
  } catch {}
  
  // 2c. 抖音 aweme API
  if (tid) {
    try {
      const r = await get(
        `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${tid}`,
        { headers: { 'Referer': 'https://www.douyin.com/' } }
      );
      const desc = r.data?.aweme_detail?.desc;
      if (desc) return desc;
    } catch {}
  }

  // 2d. iesdouyin (備用域名)
  if (tid) {
    try {
      const r = await get(`https://www.iesdouyin.com/aweme/v1/web/aweme/detail/?aweme_id=${tid}`);
      if (r.data?.aweme_detail?.desc) return r.data.aweme_detail.desc;
    } catch {}
  }

  return null;
}

// 方式三：OG 元數據抓取 (通用)
async function methodOpenGraph(url) {
  try {
    const resolved = await resolveShortUrl(url);
    const r = await get(resolved, { timeout: 6000 });
    const html = r.data;
    const meta = extractMetaDesc(html);
    if (meta) return meta;
  } catch {}
  return null;
}

// 主處理
async function extractCaption(url) {
  let caption = null;
  let platform = 'unknown';
  const u = url.toLowerCase();

  if (u.includes('douyin') || u.includes('dy')) {
    platform = '抖音/Douyin';
    caption = await methodDouyinPage(url);
    if (!caption) caption = await methodThirdParty(url);
    if (!caption) caption = await methodOpenGraph(url);
  } else if (u.includes('tiktok')) {
    platform = 'TikTok';
    caption = await methodThirdParty(url);
    if (!caption) caption = await methodOpenGraph(url);
  } else if (u.includes('bilibili') || u.includes('b23')) {
    platform = 'B站';
    caption = await methodOpenGraph(url);
    if (!caption) caption = await methodThirdParty(url);
  } else {
    platform = '其他';
    caption = await methodOpenGraph(url);
    if (!caption) caption = await methodThirdParty(url);
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
    if (result.caption) {
      res.json({ success: true, platform: result.platform, caption: result.caption, url });
    } else {
      res.json({ success: false, platform: result.platform, error: '無法提取文案', url });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: '伺服器錯誤：' + err.message });
  }
};
