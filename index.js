const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const CryptoJS = require("crypto-js");
const path = require("path");
const fs = require("fs");
const https = require("https");

const app = express();
const PORT = 3000;

const BASE = "https://hianime.to";
const MEGACLOUD = "https://megacloud.blog";
const SUBDL = "https://api.subdl.com/api/v1/subtitles";
const PUBLIC_DIR = path.join(__dirname, "public");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const scrapeHeaders = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": `${BASE}/`,
};

const otpStore = new Map();
let mailer = null;

function extractSlug(href) {
  if (!href) return "";
  return href.replace(/^\/watch\//, "").replace(/^\//, "").split("?")[0].split("#")[0].trim();
}

function scrapeWatchPage(html) {
  const $ = cheerio.load(html);
  const title = $(".anisc-detail .film-name a").first().text().trim();
  const poster = $(".anisc-poster .film-poster-img").attr("src") || "";
  const description = $(".film-description .text").text().trim();
  const rating = $(".tick-pg").first().text().trim();
  const quality = $(".tick-quality").first().text().trim();
  const subCount = $(".anisc-detail .tick-sub").text().replace(/\D/g, "");
  const dubCount = $(".anisc-detail .tick-dub").text().replace(/\D/g, "");
  const totalEps = $(".anisc-detail .tick-eps").first().text().trim();
  const animeType = $(".film-stats .item").first().text().trim();
  const duration = $(".film-stats .item").last().text().trim();
  const studio = $(".film-text .name strong").first().text().trim();
  const id = $("#wrapper").data("id");

  const genres = [];
  $(".item-list a[href*='/genre/']").each((_, el) => {
    const g = $(el).text().trim();
    if (g) genres.push(g);
  });

  const characters = [];
  $(".bac-item").each((_, el) => {
    const charName = $(el).find(".per-info.ltr .pi-name a").text().trim();
    const charRole = $(el).find(".per-info.ltr .pi-cast").text().trim();
    const charImg = $(el).find(".per-info.ltr img").attr("data-src") || $(el).find(".per-info.ltr img").attr("src") || "";
    const vaName = $(el).find(".per-info.rtl .pi-name a").text().trim();
    const vaLang = $(el).find(".per-info.rtl .pi-cast").text().trim();
    const vaImg = $(el).find(".per-info.rtl img").attr("data-src") || $(el).find(".per-info.rtl img").attr("src") || "";
    if (charName) characters.push({ charName, charRole, charImg, vaName, vaLang, vaImg });
  });

  const related = [];
  $(".block_area-realtime").first().find("li").each((_, el) => {
    const name = $(el).find(".film-name a").text().trim();
    const href = $(el).find(".film-name a").attr("href") || "";
    const img = $(el).find(".film-poster-img").attr("data-src") || "";
    const sub = $(el).find(".tick-sub").text().replace(/\D/g, "");
    const dub = $(el).find(".tick-dub").text().replace(/\D/g, "");
    const type = $(el).find(".tick").contents().filter((_, n) => n.type === "text" && n.data.trim()).last().text().trim();
    const slug = extractSlug(href);
    if (name && slug) related.push({ slug, name, img, sub, dub, type });
  });

  return { id, title, poster, description, rating, quality, subCount, dubCount, totalEps, animeType, duration, studio, genres, characters, related };
}

async function getMegacloudKey() {
  const res = await fetch("https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json");
  if (!res.ok) throw new Error("Failed to fetch megacloud keys");
  const json = await res.json();
  const key = json["mega"] || json["megacloud"] || Object.values(json)[0];
  if (!key) throw new Error("No megacloud key found");
  return key;
}

const KEY_PATTERNS = [
  /['"_]k['"]\s*[:=]\s*['"]([A-Za-z0-9_-]{20,})['"]/,
  /clientKey\s*[:=]\s*['"]([A-Za-z0-9_-]{20,})['"]/,
  /\?_k=([A-Za-z0-9_-]{20,})/,
  /key\s*[:=]\s*['"]([A-Za-z0-9_-]{20,})['"]/,
  /"([A-Za-z0-9_-]{32,})"/,
];

function extractKeyFromText(text) {
  for (const p of KEY_PATTERNS) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

function parseCookies(setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return {};
  const jar = {};
  for (const line of setCookieHeaders) {
    const part = line.split(";")[0].trim();
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const val  = part.slice(eq + 1).trim();
    if (name) jar[name] = val;
  }
  return jar;
}

function cookiesToHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function fetchMegacloudSession(mcSourceId) {
  const embedUrl = `${MEGACLOUD}/embed-2/v3/e-1/${mcSourceId}?k=1`;

  const embedRes = await axios.get(embedUrl, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": `${BASE}/`,
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
      "Upgrade-Insecure-Requests": "1",
    },
    maxRedirects: 5,
    validateStatus: null,
  });

  const cookieJar = parseCookies(embedRes.headers["set-cookie"] || []);
  console.log("Embed cookies:", Object.keys(cookieJar).join(", ") || "(none)");

  const html = typeof embedRes.data === "string" ? embedRes.data : "";
  let clientKey = extractKeyFromText(html);

  if (!clientKey) {
    const scriptMatch = html.match(/<script[^>]+src=['"]([^'"]+\/main[^'"]*\.js[^'"]*)['"][^>]*>/);
    if (scriptMatch) {
      const scriptUrl = scriptMatch[1].startsWith("http") ? scriptMatch[1] : `${MEGACLOUD}${scriptMatch[1]}`;
      try {
        const scriptRes = await axios.get(scriptUrl, {
          headers: {
            "User-Agent": UA,
            "Referer": embedUrl,
            "Accept-Language": "en-US,en;q=0.9",
          },
          validateStatus: null,
        });
        if (scriptRes.status === 200) {
          clientKey = extractKeyFromText(scriptRes.data);
        }
      } catch {}
    }
  }

  return { clientKey, cookieJar };
}

async function getSourcesWithSession(mcSourceId, clientKey, cookieJar, megacloudKey) {
  const embedReferer = `${MEGACLOUD}/embed-2/v3/e-1/${mcSourceId}?k=1`;
  const cookieHeader = cookiesToHeader(cookieJar);

  const sourcesRes = await axios.get(
    `${MEGACLOUD}/embed-2/v3/e-1/getSources?id=${mcSourceId}&_k=${clientKey}`,
    {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": embedReferer,
        "Origin": MEGACLOUD,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
      },
      validateStatus: null,
    }
  );

  return sourcesRes;
}

async function getMegacloudSources(mcSourceId, megacloudKey, attempt = 1) {
  console.log(`[Megacloud] Session attempt ${attempt} for ${mcSourceId}`);

  const { clientKey, cookieJar } = await fetchMegacloudSession(mcSourceId);
  if (!clientKey) throw new Error("Could not extract client key from embed page");

  console.log(`Client key: ${clientKey} | Cookies: ${cookiesToHeader(cookieJar) || "(none)"}`);

  const sourcesRes = await getSourcesWithSession(mcSourceId, clientKey, cookieJar, megacloudKey);

  if (sourcesRes.status === 403 && attempt < 4) {
    const delay = attempt * 1200;
    console.log(`[Megacloud] 403 on attempt ${attempt}, retrying in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    return getMegacloudSources(mcSourceId, megacloudKey, attempt + 1);
  }

  if (sourcesRes.status !== 200) {
    throw new Error(`Megacloud getSources failed: ${sourcesRes.status}`);
  }

  return { sourcesJson: sourcesRes.data, clientKey };
}

function decryptSources(encrypted, clientKey, megacloudKey) {
  let xored = "";
  for (let i = 0; i < encrypted.length; i++) {
    xored += String.fromCharCode(encrypted.charCodeAt(i) ^ clientKey.charCodeAt(i % clientKey.length));
  }

  const attempts = [
    { data: xored, key: megacloudKey },
    { data: encrypted, key: megacloudKey },
    { data: xored, key: clientKey },
  ];

  for (const { data, key } of attempts) {
    try {
      const dec = CryptoJS.AES.decrypt(data, key).toString(CryptoJS.enc.Utf8);
      if (dec && (dec.startsWith("[") || dec.startsWith("{"))) return dec;
    } catch {}
  }

  return null;
}

function srtToVtt(srt) {
  return (
    "WEBVTT\n\n" +
    srt
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
      .replace(/^\d+\s*\n/gm, "")
      .trim()
  );
}

function parseVttCues(vtt) {
  const lines = vtt.split("\n");
  const cues = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const timing = line;
      i++;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== "") {
        textLines.push(lines[i]);
        i++;
      }
      const text = textLines.join("\n").replace(/<[^>]+>/g, "").trim();
      if (text) cues.push({ timing, text });
    } else {
      i++;
    }
  }

  return cues;
}

function buildVttFromCues(cues) {
  return "WEBVTT\n\n" + cues.map(c => `${c.timing}\n${c.text}`).join("\n\n");
}

async function googleTranslateText(text, targetLang) {
  const encoded = encodeURIComponent(text);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encoded}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const translated = json[0].map(segment => segment[0]).join("");
          resolve(translated);
        } catch (err) {
          reject(new Error("Failed to parse translation response"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Translation request timed out")); });
  });
}

const TRANSLATE_CHUNK_SIZE = 50;

async function translateVttToArabic(vttContent) {
  const cues = parseVttCues(vttContent);
  if (!cues.length) throw new Error("No cues found in VTT");

  console.log(`[Translate] Translating ${cues.length} cues to Arabic...`);

  const translated = [];

  for (let i = 0; i < cues.length; i += TRANSLATE_CHUNK_SIZE) {
    const chunk = cues.slice(i, i + TRANSLATE_CHUNK_SIZE);
    const separator = "\n||||\n";
    const combined = chunk.map(c => c.text).join(separator);

    let attempts = 0;
    let result = null;

    while (attempts < 3 && !result) {
      try {
        result = await googleTranslateText(combined, "ar");
      } catch (err) {
        attempts++;
        if (attempts >= 3) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempts));
      }
    }

    const parts = result.split(/\s*\|\|\|\|\s*/);

    for (let j = 0; j < chunk.length; j++) {
      translated.push({
        timing: chunk[j].timing,
        text: (parts[j] || chunk[j].text).trim(),
      });
    }

    if (i + TRANSLATE_CHUNK_SIZE < cues.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[Translate] Done — ${translated.length} cues translated`);
  return buildVttFromCues(translated);
}

async function fetchVttContent(url) {
  const res = await axios.get(url, {
    headers: { "User-Agent": UA, "Accept": "*/*" },
    responseType: "arraybuffer",
    timeout: 15000,
    validateStatus: null,
    maxRedirects: 5,
  });

  if (res.status !== 200) throw new Error(`Failed to fetch subtitle: ${res.status}`);

  const raw = Buffer.from(res.data).toString("utf8");
  return raw.trimStart().startsWith("WEBVTT") ? raw : srtToVtt(raw);
}

async function fetchSubdlTracks(title, epNum, missingLangs) {
  const extra = [];

  for (const lang of missingLangs) {
    try {
      const params = new URLSearchParams({
        film_name: title,
        type: "TV",
        episode_number: String(epNum),
        season_number: "1",
        languages: lang.code,
        subs_per_page: "3",
      });

      const res = await axios.get(`${SUBDL}?${params}`, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        timeout: 8000,
        validateStatus: null,
      });

      if (res.status !== 200 || !res.data?.subtitles?.length) {
        console.log(`[SubDL] No ${lang.label} subtitle for "${title}" ep ${epNum}`);
        continue;
      }

      const subs = res.data.subtitles;
      const picked =
        subs.find(s => s.url.endsWith(".vtt")) ||
        subs.find(s => s.url.endsWith(".srt")) ||
        subs[0];

      const subUrl = picked.url.startsWith("http")
        ? picked.url
        : `https://dl.subdl.com${picked.url}`;

      console.log(`[SubDL] Found ${lang.label}: ${subUrl}`);

      extra.push({
        kind: "subtitles",
        label: `${lang.label} [SubDL]`,
        lang: lang.code.toLowerCase(),
        file: `/subtitles?url=${encodeURIComponent(subUrl)}`,
      });
    } catch (err) {
      console.log(`[SubDL] ${lang.label} error: ${err.message}`);
    }
  }

  return extra;
}

async function buildArabicFromEnglish(tracks, rawTracks) {
  const englishTrack =
    tracks.find(t => (t.label || "").toLowerCase().includes("english")) ||
    tracks.find(t => (t.lang || t.language || "").toLowerCase() === "en") ||
    tracks.find(t => (t.label || "").toLowerCase().includes("eng"));

  if (!englishTrack) {
    console.log("[Translate] No English track found to translate from — skipping Arabic generation");
    return null;
  }

  let sourceUrl = englishTrack.file;

  if (sourceUrl.startsWith("/proxy?url=") || sourceUrl.startsWith("/subtitles?url=")) {
    const inner = decodeURIComponent(sourceUrl.split("?url=")[1]);
    sourceUrl = inner;
  }

  console.log(`[Translate] Fetching English track for translation: ${sourceUrl}`);

  let vttContent;
  try {
    vttContent = await fetchVttContent(sourceUrl);
  } catch (err) {
    console.log(`[Translate] Failed to fetch English track: ${err.message}`);
    return null;
  }

  let arabicVtt;
  try {
    arabicVtt = await translateVttToArabic(vttContent);
  } catch (err) {
    console.log(`[Translate] Translation failed: ${err.message}`);
    return null;
  }

  return arabicVtt;
}

const translationCache = new Map();

app.get("/manifest.json", (req, res) => {
  res.setHeader("Content-Type", "application/manifest+json");
  res.json({
    name: "AniSearch",
    short_name: "AniSearch",
    description: "Search and watch anime offline",
    start_url: "/",
    display: "standalone",
    background_color: "#080810",
    theme_color: "#080810",
    icons: [
      {
        src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%23ff6b35'/%3E%3Ctext y='.9em' font-size='80' x='10'%3E%E2%96%B6%3C/text%3E%3C/svg%3E",
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  });
});

app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Service-Worker-Allowed", "/");
  const swCode = `
const CACHE = 'anisearch-v2';
const OFFLINE_URL = '/offline';
const SHELL = ['/', '/offline'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      return Promise.allSettled(SHELL.map(url => c.add(url)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/proxy')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => {
      return caches.match(e.request).then(cached => {
        if (cached) return cached;
        if (e.request.destination === 'document') return caches.match('/offline');
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
`;
  res.send(swCode.trim());
});

app.get("/offline", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AniSearch — Offline</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080810; color: #e8e8f0; font-family: 'DM Sans', system-ui, sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; }
  .logo { font-size: 4rem; letter-spacing: 0.12em; background: linear-gradient(135deg, #ff6b35, #ff9a5c); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 16px; font-weight: 900; }
  .icon { font-size: 64px; margin-bottom: 20px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; }
  p { color: #666688; font-size: 14px; line-height: 1.7; max-width: 340px; margin-bottom: 28px; }
  a { display: inline-block; padding: 12px 28px; background: #ff6b35; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; transition: background 0.15s; }
  a:hover { background: #ff9a5c; }
</style>
</head>
<body>
<div class="logo">AniSearch</div>
<div class="icon">📡</div>
<h1>You're offline</h1>
<p>No internet connection detected. Head back to the app — your downloaded episodes are still available in the Downloads tab.</p>
<a href="/">Go to Downloads</a>
</body>
</html>`);
});

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ results: [] });

  try {
    const url = `${BASE}/search?keyword=${encodeURIComponent(q)}`;
    const { data } = await axios.get(url, { headers: scrapeHeaders });
    const $ = cheerio.load(data);
    const results = [];

    $(".flw-item").each((_, el) => {
      const name = $(el).find(".film-name a").text().trim();
      const rawHref = $(el).find(".film-poster-ahref").attr("href") || $(el).find(".film-name a").attr("href") || "";
      const img = $(el).find(".film-poster-img").attr("data-src") || $(el).find(".film-poster-img").attr("src") || "";
      const type = $(el).find(".fdi-item").first().text().trim();
      const duration = $(el).find(".fdi-duration").text().trim();
      const sub = $(el).find(".tick-sub").text().replace(/\D/g, "");
      const dub = $(el).find(".tick-dub").text().replace(/\D/g, "");
      const rating = $(el).find(".tick-rate, .tick-pg").first().text().trim();
      const slug = extractSlug(rawHref);
      if (name && slug) results.push({ slug, name, img, type, duration, sub, dub, rating });
    });

    res.json({ results });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed", message: err.message });
  }
});

app.get("/api/detail", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "Missing slug" });

  try {
    const { data: html } = await axios.get(`${BASE}/watch/${slug}`, { headers: scrapeHeaders });
    const anime = scrapeWatchPage(html);
    anime.slug = slug;

    if (!anime.id) throw new Error("No anime ID found");

    const { data: epResponse } = await axios.get(`${BASE}/ajax/v2/episode/list/${anime.id}`, { headers: scrapeHeaders });
    const $ep = cheerio.load(epResponse.html);

    const episodes = [];
    $ep("a.ep-item").each((_, el) => {
      const num = parseInt($ep(el).attr("data-number")) || 0;
      const title = $ep(el).attr("title") || `Episode ${num}`;
      const epId = $ep(el).attr("data-id");
      if (num && epId) episodes.push({ num, title, epId });
    });
    episodes.sort((a, b) => a.num - b.num);
    anime.episodes = episodes;

    res.json(anime);
  } catch (err) {
    console.error("Detail error:", err.message);
    res.status(500).json({ error: "Failed to load anime", message: err.message });
  }
});

app.get("/api/sources", async (req, res) => {
  const { epId, category = "sub", title = "", epNum = "1" } = req.query;
  if (!epId) return res.status(400).json({ error: "epId is required" });

  try {
    const serversRes = await axios.get(`${BASE}/ajax/v2/episode/servers?episodeId=${epId}`, {
      headers: {
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `${BASE}/`,
        "Accept-Language": "en-US,en;q=0.9",
      },
      validateStatus: null,
    });
    if (serversRes.status !== 200) throw new Error(`HiAnime servers request failed: ${serversRes.status}`);

    const serversJson = serversRes.data;
    if (!serversJson.html || typeof serversJson.html !== "string") {
      throw new Error("Unexpected response from HiAnime servers endpoint");
    }

    const $ = cheerio.load(serversJson.html);
    let serverItem = null;
    $(".server-item").each((_, el) => {
      if ($(el).attr("data-type") === category && !serverItem) serverItem = $(el);
    });

    if (!serverItem) {
      const available = [];
      $(".server-item").each((_, el) => available.push($(el).attr("data-type")));
      throw new Error(`No ${category} server found. Available: ${[...new Set(available)].join(", ") || "none"}`);
    }

    const sourceId = serverItem.attr("data-id");
    if (!sourceId) throw new Error("Server item missing data-id");
    console.log(`[${category}] Server ID: ${sourceId}`);

    const embedRes = await axios.get(`${BASE}/ajax/v2/episode/sources?id=${sourceId}`, {
      headers: {
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `${BASE}/`,
        "Accept-Language": "en-US,en;q=0.9",
      },
      validateStatus: null,
    });
    if (embedRes.status !== 200) throw new Error(`HiAnime sources request failed: ${embedRes.status}`);

    const embedJson = embedRes.data;
    const embedUrl = embedJson.link;
    if (!embedUrl) throw new Error("No embed URL returned");
    console.log("Embed URL:", embedUrl);

    const mcSourceId = embedUrl.split("/").pop().split("?")[0];
    console.log("Megacloud source ID:", mcSourceId);

    const megacloudKey = await getMegacloudKey();
    const { sourcesJson, clientKey } = await getMegacloudSources(mcSourceId, megacloudKey);
    console.log("Encrypted:", sourcesJson.encrypted);

    let decryptedSources;
    if (!sourcesJson.encrypted) {
      decryptedSources = sourcesJson.sources;
    } else {
      if (typeof sourcesJson.sources !== "string") throw new Error("Expected encrypted sources to be a string");
      const decrypted = decryptSources(sourcesJson.sources, clientKey, megacloudKey);
      if (!decrypted) throw new Error("Failed to decrypt sources — key may be outdated");
      decryptedSources = JSON.parse(decrypted);
    }

    const sourceUrl = Array.isArray(decryptedSources) ? decryptedSources[0]?.file : decryptedSources?.file;
    if (!sourceUrl) throw new Error("No source URL after decryption");
    console.log("Source URL:", sourceUrl);

    const tracks = (sourcesJson.tracks || [])
      .filter(t => t.kind === "captions" || t.kind === "subtitles")
      .map(t => ({ ...t, file: t.file ? `/proxy?url=${encodeURIComponent(t.file)}` : t.file }));

    const rawTracks = (sourcesJson.tracks || []).filter(t => t.kind === "captions" || t.kind === "subtitles");

    const existingLangs = tracks.flatMap(t => [
      (t.label || "").toLowerCase(),
      (t.lang || t.language || "").toLowerCase(),
    ]);

    const hasArabic  = existingLangs.some(l => l.includes("arab") || l === "ar");
    const hasEnglish = existingLangs.some(l => l.includes("english") || l === "en");

    console.log(`Existing tracks: ${tracks.map(t => t.label).join(", ") || "none"}`);
    console.log(`Has Arabic: ${hasArabic} | Has English: ${hasEnglish}`);

    const missingLangs = [];
    if (!hasEnglish) missingLangs.push({ code: "EN", label: "English" });

    if (missingLangs.length > 0 && title) {
      console.log(`[SubDL] Fetching: ${missingLangs.map(l => l.label).join(", ")} for "${title}" ep ${epNum}`);
      const extra = await fetchSubdlTracks(title, epNum, missingLangs);
      tracks.push(...extra);
    }

    if (!hasArabic) {
      const cacheKey = `${epId}:${category}`;
      if (translationCache.has(cacheKey)) {
        console.log("[Translate] Serving cached Arabic translation");
        tracks.push({
          kind: "subtitles",
          label: "Arabic [Auto]",
          lang: "ar",
          file: `/translated-arabic?key=${encodeURIComponent(cacheKey)}`,
        });
      } else {
        const allTracksForTranslation = [...rawTracks.map(t => ({
          ...t,
          file: t.file || "",
        })), ...tracks.filter(t => t.label?.includes("SubDL"))];

        console.log("[Translate] No Arabic track — generating from English...");

        buildArabicFromEnglish(allTracksForTranslation, rawTracks).then(arabicVtt => {
          if (arabicVtt) {
            translationCache.set(cacheKey, arabicVtt);
            console.log(`[Translate] Arabic translation cached for ${cacheKey}`);
          }
        }).catch(err => {
          console.log("[Translate] Background translation error:", err.message);
        });

        tracks.push({
          kind: "subtitles",
          label: "Arabic [Auto - Loading]",
          lang: "ar",
          file: `/translated-arabic?key=${encodeURIComponent(cacheKey)}&wait=1`,
        });
      }
    }

    res.json({
      source: `/proxy?url=${encodeURIComponent(sourceUrl)}`,
      tracks,
      intro: sourcesJson.intro || null,
      outro: sourcesJson.outro || null,
    });
  } catch (err) {
    console.error("[/api/sources]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/segments", async (req, res) => {
  const { epId, category = "sub" } = req.query;
  if (!epId) return res.status(400).json({ error: "epId is required" });

  try {
    const serversRes = await axios.get(`${BASE}/ajax/v2/episode/servers?episodeId=${epId}`, {
      headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": `${BASE}/`, "Accept-Language": "en-US,en;q=0.9" },
      validateStatus: null,
    });
    if (serversRes.status !== 200) throw new Error(`Servers request failed: ${serversRes.status}`);

    const $ = cheerio.load(serversRes.data.html);
    let serverItem = null;
    $(".server-item").each((_, el) => {
      if ($(el).attr("data-type") === category && !serverItem) serverItem = $(el);
    });
    if (!serverItem) throw new Error(`No ${category} server found`);

    const sourceId = serverItem.attr("data-id");
    const embedRes = await axios.get(`${BASE}/ajax/v2/episode/sources?id=${sourceId}`, {
      headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": `${BASE}/` },
      validateStatus: null,
    });
    const embedUrl = embedRes.data?.link;
    if (!embedUrl) throw new Error("No embed URL");

    const mcSourceId = embedUrl.split("/").pop().split("?")[0];
    const megacloudKey = await getMegacloudKey();
    const { sourcesJson, clientKey } = await getMegacloudSources(mcSourceId, megacloudKey);

    let decryptedSources;
    if (!sourcesJson.encrypted) {
      decryptedSources = sourcesJson.sources;
    } else {
      const decrypted = decryptSources(sourcesJson.sources, clientKey, megacloudKey);
      if (!decrypted) throw new Error("Decryption failed");
      decryptedSources = JSON.parse(decrypted);
    }

    const sourceUrl = Array.isArray(decryptedSources) ? decryptedSources[0]?.file : decryptedSources?.file;
    if (!sourceUrl) throw new Error("No source URL");

    const m3u8Res = await axios.get(sourceUrl, {
      headers: { "User-Agent": UA, "Referer": `${MEGACLOUD}/`, "Origin": MEGACLOUD },
      responseType: "text",
      validateStatus: null,
    });
    if (m3u8Res.status !== 200) throw new Error(`m3u8 fetch failed: ${m3u8Res.status}`);

    const m3u8Text = m3u8Res.data;
    const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf("/") + 1);

    const variantMatch = m3u8Text.match(/^[^#].+\.m3u8/m);
    let playlistText = m3u8Text;
    let playlistBase = baseUrl;

    if (variantMatch) {
      const variantUrl = variantMatch[0].startsWith("http") ? variantMatch[0] : baseUrl + variantMatch[0];
      const variantRes = await axios.get(variantUrl, {
        headers: { "User-Agent": UA, "Referer": `${MEGACLOUD}/`, "Origin": MEGACLOUD },
        responseType: "text",
        validateStatus: null,
      });
      if (variantRes.status === 200) {
        playlistText = variantRes.data;
        playlistBase = variantUrl.substring(0, variantUrl.lastIndexOf("/") + 1);
      }
    }

    const segments = [];
    const durations = [];
    let pendingDur = null;
    let targetDuration = 0;

    for (const rawLine of playlistText.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        const v = parseFloat(line.split(":")[1]);
        if (!Number.isNaN(v)) targetDuration = v;
        continue;
      }

      if (line.startsWith("#EXTINF:")) {
        const durStr = line.slice("#EXTINF:".length).split(",")[0];
        const dur = parseFloat(durStr);
        pendingDur = Number.isFinite(dur) && dur > 0 ? dur : null;
        continue;
      }

      if (line.startsWith("#")) continue;

      const absUrl = line.startsWith("http") ? line : playlistBase + line;
      segments.push(`/proxy?url=${encodeURIComponent(absUrl)}`);
      durations.push(pendingDur);
      pendingDur = null;
    }

    if (!segments.length) throw new Error("No segments found");
    res.json({
      segments,
      total: segments.length,
      durations,
      targetDuration: targetDuration || null,
    });
  } catch (err) {
    console.error("[/api/segments]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/translated-arabic", async (req, res) => {
  const key = req.query.key;
  const wait = req.query.wait === "1";

  if (!key) return res.status(400).send("Missing key");

  if (translationCache.has(key)) {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(translationCache.get(key));
  }

  if (!wait) {
    return res.status(404).send("Translation not ready");
  }

  const maxWait = 120000;
  const interval = 800;
  let elapsed = 0;

  const poll = setInterval(() => {
    elapsed += interval;
    if (translationCache.has(key)) {
      clearInterval(poll);
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.send(translationCache.get(key));
    }
    if (elapsed >= maxWait) {
      clearInterval(poll);
      res.status(504).send("Translation timed out");
    }
  }, interval);

  req.on("close", () => clearInterval(poll));
});

app.get("/subtitles", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url");

  try {
    const upstream = await axios.get(target, {
      headers: { "User-Agent": UA, "Accept": "*/*" },
      responseType: "arraybuffer",
      timeout: 10000,
      validateStatus: null,
      maxRedirects: 5,
    });

    if (upstream.status !== 200) return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);

    const raw = Buffer.from(upstream.data).toString("utf8");
    const vtt = raw.trimStart().startsWith("WEBVTT") ? raw : srtToVtt(raw);

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(vtt);
  } catch (err) {
    console.error("[/subtitles]", err.message);
    res.status(500).send(err.message);
  }
});

app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url");

  try {
    const upstream = await axios.get(target, {
      headers: {
        "User-Agent": UA,
        "Referer": `${MEGACLOUD}/`,
        "Origin": MEGACLOUD,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      responseType: "arraybuffer",
      validateStatus: null,
      maxRedirects: 5,
    });

    if (upstream.status !== 200) return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);

    const contentType = upstream.headers["content-type"] || "application/octet-stream";
    res.setHeader("Access-Control-Allow-Origin", "*");

    const isM3U8 = target.includes(".m3u8") || contentType.includes("mpegurl");
    if (isM3U8) {
      const base = target.substring(0, target.lastIndexOf("/") + 1);
      let text = Buffer.from(upstream.data).toString("utf8");
      text = text.replace(/^(?!#)(.+)$/gm, line => {
        line = line.trim();
        if (!line) return line;
        const abs = line.startsWith("http") ? line : base + line;
        return `/proxy?url=${encodeURIComponent(abs)}`;
      });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(text);
    }

    const isTS = target.includes(".ts") || contentType.includes("MP2T") || contentType.includes("mp2t");
    res.setHeader("Content-Type", isTS ? "video/MP2T" : contentType);
    res.send(Buffer.from(upstream.data));
  } catch (err) {
    console.error("[/proxy]", err.message);
    res.status(500).send(err.message);
  }
});

app.post("/api/auth/verify-otp", express.json(), async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: "Missing fields" });

  const entry = otpStore.get(email.toLowerCase());
  if (!entry) return res.status(400).json({ error: "No pending verification for this email. Please sign up again." });
  if (Date.now() > entry.expires) {
    otpStore.delete(email.toLowerCase());
    return res.status(400).json({ error: "Code expired. Please sign up again." });
  }
  if (entry.code !== String(code).trim()) {
    return res.status(400).json({ error: "Incorrect code. Try again." });
  }

  otpStore.delete(email.toLowerCase());
  res.json({ ok: true, displayName: entry.displayName, username: entry.username });
});

app.listen(PORT, () => {
  console.log(`\nAniSearch running at http://localhost:${PORT}`);
  console.log(`Serving static files from: ${PUBLIC_DIR}`);
  console.log(`index.html exists: ${fs.existsSync(path.join(PUBLIC_DIR, "index.html"))}\n`);
});