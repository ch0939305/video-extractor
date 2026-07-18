// Vercel Serverless Function — 影片文案提取 API
// 支援：抖音、TikTok、B站、小紅書
// deploy: 放 /api/extract.js

const axios = require('axios');

// 抖音短網址還原
async function resolveShortUrl(url) {
  try {
    const resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: s => s >= 200 && s < 400,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' }
    });
    return resp.headers.location || url;
  } catch { return url; }
}

// 從抖音頁面 HTML 撈文案
async function extractFromDouyinPage(videoUrl) {
  const resolved = await resolveShortUrl(videoUrl);
  const resp = await axios.get(resolved, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      'Cookie': 's_v_web_id=verify_xxx; __ac_nonce=xxx;'
    },
    timeout: 10000
  });
  const html = resp.data;

  // 找 RENDER_DATA (base64)
  const rdm = html.match(/<script id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (rdm) {
    try {
      const decoded = Buffer.from(rdm[1], 'base64').toString('utf8');
      const dm = decoded.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (dm) return dm[1].replace(/\\u0026/g, '&').replace(/\\n/g, '\n');
    } catch {}
  }

  // 找 SSR RENDER_DATA (JSON)
  const srm = html.match(/window\.__SSR_RENDER_DATA__\s*=\s*({.+?});?<\/script>/);
  if (srm) {
    try {
      const d = JSON.parse(srm[1]);
      const desc = d?.app?.videoInfoRes?.item_list?.[0]?.desc;
      if (desc) return desc;
    } catch {}
  }

  return null;
}

// 透過第三方服務提取
async function extractFromThirdParty(videoUrl) {
  // 取得完整網址
  const resolved = videoUrl.includes('douyin.com/video/')
    ? videoUrl
    : await resolveShortUrl(videoUrl);

  // 1. tikwm API
  try {
    const resp = await axios.get('https://www.tikwm.com/api/', {
      params: { url: resolved },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    if (resp.data?.code === 0 && resp.data?.data?.title) {
      return resp.data.data.title;
    }
  } catch {}

  // 2. 嘗試直接抓 aweme API (抖音內部)
  const vidMatch = resolved.match(/\/video\/(\d+)/);
  if (vidMatch) {
    try {
      const awemeId = vidMatch[1];
      const resp = await axios.get(
        `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&version_code=173600`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.douyin.com/',
            'Cookie': 's_v_web_id=verify_xxx;'
          },
          timeout: 8000
        }
      );
      const desc = resp.data?.aweme_detail?.desc;
      if (desc) return desc;
    } catch {}
  }

  return null;
}

// 主處理函數
async function extractCaption(url) {
  let caption = null;
  let platform = 'unknown';
  const u = url.toLowerCase();

  if (u.includes('douyin') || u.includes('dy')) {
    platform = '抖音';
    caption = await extractFromDouyinPage(url);
    if (!caption) caption = await extractFromThirdParty(url);
  } else if (u.includes('tiktok')) {
    platform = 'TikTok';
    caption = await extractFromThirdParty(url);
  } else if (u.includes('bilibili') || u.includes('b23')) {
    platform = 'B站';
    caption = await extractFromThirdParty(url);
  } else {
    platform = '其他';
    caption = await extractFromThirdParty(url);
  }

  return { platform, caption };
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.query.url || req.body?.url;
  if (!url) {
    return res.status(400).json({ success: false, error: '請提供影片網址' });
  }

  try {
    const result = await extractCaption(url);
    if (result.caption) {
      res.json({
        success: true,
        platform: result.platform,
        caption: result.caption,
        url: url
      });
    } else {
      res.json({
        success: false,
        platform: result.platform,
        error: '無法提取文案，可能該影片無文字描述或 API 限流',
        url: url
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: '伺服器錯誤：' + err.message });
  }
};
