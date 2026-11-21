import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { chromium as playwrightChromium, BrowserContext, CDPSession, Page } from 'playwright-core';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = 3000;
const ADMIN_PIN = '2014';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const GLOBAL_STATE_FILE = path.join(DATA_DIR, 'global-os-state.json');
const PUBLIC_VERSION_FILE = path.resolve(process.cwd(), 'public', 'version.json');
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

export interface CustomGlobalApp {
  id: string;
  name: string;
  description: string;
  kind: 'url' | 'html';
  url?: string;
  html?: string;
  accentHex: string;
  createdAt: number;
}

export interface SiteLinksConfig {
  mertyusufdeniz: string;
  hdfilix: string;
  haberler: string;
  poki: string;
  defaultSearchEngine: 'my-google' | 'google' | 'duckduckgo';
}

export interface AIConfig {
  model: string;
  systemInstruction: string;
  enabled: boolean;
}

export interface OtaPayload {
  announcementBanner?: string;
  defaultAccentColor?: string;
  defaultColorMode?: 'light' | 'dark' | 'custom';
  defaultIconSize?: 'small' | 'medium' | 'large';
  defaultTaskbarAlign?: 'center' | 'left';
  defaultWallpaperId?: string;
  defaultSystemFont?: 'jakarta' | 'inter' | 'roboto' | 'mono' | 'system';
  defaultTransparencyEnabled?: boolean;
  siteLinksPatch?: Partial<SiteLinksConfig>;
  addedStoreApps?: Omit<CustomGlobalApp, 'id' | 'createdAt'>[];
}

export interface GlobalOSState {
  manifest: {
    version: string;
    codename: string;
    build: string;
    channel: string;
    releaseDate: string;
    notes: string[];
    activeModules: string[];
    otaPayload?: OtaPayload;
  };
  customApps: CustomGlobalApp[];
  siteLinks: SiteLinksConfig;
  aiConfig: AIConfig;
}

function loadDefaultManifest() {
  try {
    if (fs.existsSync(PUBLIC_VERSION_FILE)) {
      return JSON.parse(fs.readFileSync(PUBLIC_VERSION_FILE, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {
    version: '18.0.0',
    codename: 'Mica Core',
    build: '18000.20261120',
    channel: 'Kararlı',
    releaseDate: '2026-11-20',
    notes: ['MY SYSTEM 18 Çekirdek Sürümü'],
    activeModules: ['core.windowManager', 'core.vfs', 'core.personalization'],
  };
}

function createInitialGlobalState(): GlobalOSState {
  return {
    manifest: loadDefaultManifest(),
    customApps: [],
    siteLinks: {
      mertyusufdeniz: 'https://mertyusufdeniz.tr',
      hdfilix: 'https://hdfilix.mertyusufdeniz.tr',
      haberler: 'my://haberler',
      poki: 'https://poki.com/tr',
      defaultSearchEngine: 'my-google',
    },
    aiConfig: {
      model: DEFAULT_GEMINI_MODEL,
      systemInstruction:
        'Sen MY SYSTEM 18 işletim sisteminin akıllı sistem asistanısın. Türkçe, net, yardımcı ve kısa yanıtlar ver. Kullanıcı sistem ayarı, uygulama açma, dosya/klasör oluşturma, arama yapma veya genel bilgi istediğinde uygun aksiyonu seç.',
      enabled: true,
    },
  };
}

function readGlobalState(): GlobalOSState {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(GLOBAL_STATE_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(GLOBAL_STATE_FILE, 'utf-8')
      ) as Partial<GlobalOSState>;
      const fallback = createInitialGlobalState();
      const rawAi = { ...fallback.aiConfig, ...(parsed.aiConfig || {}) };
      // Force migrate away from hydrogen to Gemini 3
      if (!rawAi.model || rawAi.model.includes('hydrogen')) {
        rawAi.model = DEFAULT_GEMINI_MODEL;
      }
      return {
        manifest: parsed.manifest || fallback.manifest,
        customApps: parsed.customApps || [],
        siteLinks: { ...fallback.siteLinks, ...(parsed.siteLinks || {}) },
        aiConfig: rawAi,
      };
    }
  } catch {
    // ignore
  }
  const initial = createInitialGlobalState();
  writeGlobalState(initial);
  return initial;
}

function writeGlobalState(state: GlobalOSState) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(GLOBAL_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isLikelyTurkishText(text: string): boolean {
  if (!text) return false;
  if (/[çğıöşüÇĞİÖŞÜ]/.test(text)) return true;
  const words = text.toLowerCase();
  return /\b(ve|için|ile|nedir|nasıl|türkiye|hakkında|güncel|ücretsiz|bilgi|video|haber)\b/.test(
    words
  );
}

function cleanNoiseSnippet(text: string): string {
  return text
    .replace(/AboutPressCopyrightContact.*?Google LLC/gi, '')
    .replace(/PrivacyPolicy\s*&\s*SafetyHow YouTube works.*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function liveWebSearchFallback(query: string) {
  const results: Array<{ title: string; url: string; snippet?: string }> = [];

  // 1. Turkish Wikipedia OpenSearch + Summary Extract (always clean Turkish knowledge)
  let wikiExtract = '';
  try {
    const wikiRes = await fetchWithTimeout(
      `https://tr.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=4&namespace=0&format=json`,
      { headers: { 'User-Agent': 'MYSYSTEM18/1.0' } },
      4500
    );
    if (wikiRes.ok) {
      const data = (await wikiRes.json()) as [string, string[], string[], string[]];
      const titles = data[1] || [];
      const urls = data[3] || [];
      for (let i = 0; i < titles.length; i++) {
        if (urls[i]) {
          results.push({ title: `${titles[i]} — Vikipedi TR`, url: urls[i] });
        }
      }
      if (titles[0]) {
        try {
          const sumRes = await fetchWithTimeout(
            `https://tr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titles[0].replace(/ /g, '_'))}`,
            { headers: { 'User-Agent': 'MYSYSTEM18/1.0' } },
            3500
          );
          if (sumRes.ok) {
            const sumData = (await sumRes.json()) as { extract?: string };
            if (sumData.extract) {
              wikiExtract = sumData.extract.slice(0, 320);
              if (results[0]) results[0].snippet = wikiExtract;
            }
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore wiki failure
  }

  // 2. DuckDuckGo HTML search locked to Turkey region (kl=tr-tr)
  try {
    const ddgRes = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=tr-tr`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept-Language': 'tr-TR,tr;q=0.9',
        },
      },
      6000
    );
    if (ddgRes.ok) {
      const html = await ddgRes.text();
      const linkMatches = Array.from(
        html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
      );
      const snippetMatches = Array.from(
        html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)
      );
      const collected: Array<{ title: string; url: string; snippet?: string }> = [];
      for (let i = 0; i < Math.min(linkMatches.length, 10); i++) {
        let href = linkMatches[i][1];
        const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
        if (uddgMatch) {
          href = decodeURIComponent(uddgMatch[1]);
        } else if (href.startsWith('//')) {
          href = 'https:' + href;
        }
        const title = decodeHtmlEntities(linkMatches[i][2]);
        const rawSnippet = snippetMatches[i] ? decodeHtmlEntities(snippetMatches[i][1]) : '';
        const snippet = cleanNoiseSnippet(rawSnippet);
        if (title && /^https?:\/\//i.test(href) && !results.some((r) => r.url === href)) {
          collected.push({ title, url: href, snippet });
        }
      }
      // Prioritize Turkish-language results & .tr domains first
      collected.sort((a, b) => {
        const scoreA =
          (isLikelyTurkishText(a.title + ' ' + (a.snippet || '')) ? 2 : 0) +
          (/\.tr(\/|$)/i.test(a.url) ? 2 : 0);
        const scoreB =
          (isLikelyTurkishText(b.title + ' ' + (b.snippet || '')) ? 2 : 0) +
          (/\.tr(\/|$)/i.test(b.url) ? 2 : 0);
        return scoreB - scoreA;
      });
      results.push(...collected.slice(0, 8));
    }
  } catch {
    // ignore DDG failure
  }

  // 3. Direct Google TR / Portal links if network blocked
  if (results.length === 0) {
    results.push(
      {
        title: `Google Türkiye'de "${query}" Ara`,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=tr`,
        snippet: 'Arama sorgusunu MY Tarayıcı içinde Google sonuçlarıyla açın.',
      },
      {
        title: `Vikipedi Türkçe'de "${query}"`,
        url: `https://tr.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}`,
        snippet: 'Türkçe Vikipedi ansiklopedisinde ara.',
      }
    );
  }

  const turkishSnippets = results
    .filter((r) => r.snippet && isLikelyTurkishText(r.snippet))
    .slice(0, 3)
    .map((r) => `• ${r.title}: ${r.snippet}`);

  const summary = wikiExtract
    ? `"${query}" hakkında Türkçe ansiklopedik özet:\n${wikiExtract}\n\n${results.length} adet web sonucu aşağıda listelendi.`
    : turkishSnippets.length > 0
      ? `"${query}" için Türkçe canlı web sonuçları:\n\n${turkishSnippets.join('\n')}`
      : `"${query}" için ${results.length} canlı web bağlantısı bulundu. İstediğiniz bağlantıya tıklayarak MY Tarayıcı içinde açabilirsiniz.`;

  return { summary, results };
}

const DIRECT_NEWS_FEEDS: Record<string, Array<{ url: string; source: string }>> = {
  gundem: [
    { url: 'https://www.trthaber.com/sondakika.rss', source: 'TRT Haber' },
    { url: 'https://www.ntv.com.tr/son-dakika.rss', source: 'NTV' },
    { url: 'https://www.aa.com.tr/tr/rss/default?cat=guncel', source: 'Anadolu Ajansı' },
  ],
  teknoloji: [
    { url: 'https://www.webtekno.com/rss.xml', source: 'Webtekno' },
    { url: 'https://shiftdelete.net/feed', source: 'ShiftDelete.Net' },
    { url: 'https://www.trthaber.com/bilim_teknoloji.rss', source: 'TRT Teknoloji' },
  ],
  ekonomi: [
    { url: 'https://www.trthaber.com/ekonomi.rss', source: 'TRT Ekonomi' },
    { url: 'https://www.ntv.com.tr/ekonomi.rss', source: 'NTV Ekonomi' },
    { url: 'https://www.aa.com.tr/tr/rss/default?cat=ekonomi', source: 'AA Ekonomi' },
  ],
  bilim: [
    { url: 'https://www.trthaber.com/bilim_teknoloji.rss', source: 'TRT Bilim' },
    { url: 'https://evrimagaci.org/rss.xml', source: 'Evrim Ağacı' },
    { url: 'https://www.webtekno.com/rss.xml', source: 'Webtekno' },
  ],
  spor: [
    { url: 'https://www.trthaber.com/spor.rss', source: 'TRT Spor' },
    { url: 'https://www.ntv.com.tr/spor.rss', source: 'NTV Spor' },
    { url: 'https://www.aa.com.tr/tr/rss/default?cat=spor', source: 'AA Spor' },
  ],
};

function parseRssXml(xml: string, fallbackSource: string) {
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = Array.from(
    xml.matchAll(isAtom ? /<entry[\s>]([\s\S]*?)<\/entry>/gi : /<item[\s>]([\s\S]*?)<\/item>/gi)
  ).slice(0, 12);

  const items: Array<{ title: string; url: string; pubDate?: string; source?: string }> = [];
  for (const match of blocks) {
    const block = match[1];
    const title = decodeHtmlEntities((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    let link = '';
    if (isAtom) {
      const atomLink = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
      link = atomLink?.[1] || '';
    } else {
      link = decodeHtmlEntities((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '');
      if (!link) {
        const guid = decodeHtmlEntities((block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || [])[1] || '');
        if (/^https?:\/\//i.test(guid)) link = guid;
      }
    }
    const pubDate = decodeHtmlEntities(
      (block.match(/<(?:pubDate|updated|published)[^>]*>([\s\S]*?)<\/(?:pubDate|updated|published)>/i) || [])[1] ||
        ''
    );
    if (
      title &&
      /^https?:\/\//i.test(link) &&
      !link.includes('news.google.com/rss/articles')
    ) {
      items.push({ title, url: link.trim(), pubDate, source: fallbackSource });
    }
  }
  return items;
}

async function fetchDirectTurkishNews(categoryId?: string, categoryQuery?: string) {
  const feeds =
    DIRECT_NEWS_FEEDS[(categoryId || 'gundem').toLowerCase()] || DIRECT_NEWS_FEEDS.gundem;

  const responses = await Promise.allSettled(
    feeds.map(async (f) => {
      const res = await fetchWithTimeout(
        f.url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Accept-Language': 'tr-TR,tr;q=0.9',
          },
        },
        6000
      );
      if (!res.ok) throw new Error('RSS hata');
      const xml = await res.text();
      return parseRssXml(xml, f.source);
    })
  );

  const merged: Array<{ title: string; url: string; pubDate?: string; source?: string }> = [];
  const seenUrls = new Set<string>();
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      for (const art of r.value) {
        if (!seenUrls.has(art.url)) {
          seenUrls.add(art.url);
          merged.push(art);
        }
      }
    }
  }

  if (merged.length > 0) {
    return merged.slice(0, 16);
  }

  // Fallback to live Turkish DuckDuckGo news results (direct URLs, never broken Google redirect wrappers)
  const web = await liveWebSearchFallback(`${categoryQuery || 'Türkiye haberler'} son dakika`);
  return web.results
    .filter((r) => !r.url.includes('news.google.com/rss/articles'))
    .map((r) => ({
      title: r.title,
      url: r.url,
      source: new URL(r.url).hostname.replace(/^www\./, ''),
    }));
}

function buildDeterministicOtaFromPrompt(
  prompt: string,
  currentVersion: string,
  customVersion?: string
) {
  const lower = prompt.toLocaleLowerCase('tr-TR');
  const verMatch = prompt.match(/\b(\d+\.\d+\.\d+)\b/);
  const parts = currentVersion.split('.').map((n) => parseInt(n, 10) || 0);
  const autoNext = `${parts[0] || 18}.${(parts[1] || 0) + 1}.0`;
  let version = (customVersion || verMatch?.[1] || autoNext).trim();
  if (version === currentVersion) {
    version = `${parts[0] || 18}.${parts[1] || 0}.${(parts[2] || 0) + 1}`;
  }

  const payload: OtaPayload = {};
  const notes: string[] = [];

  if (lower.includes('kırmızı')) payload.defaultAccentColor = '#dc2626';
  else if (lower.includes('yeşil') || lower.includes('zümrüt')) payload.defaultAccentColor = '#059669';
  else if (lower.includes('turuncu') || lower.includes('amber')) payload.defaultAccentColor = '#d97706';
  else if (lower.includes('mor') || lower.includes('indigo')) payload.defaultAccentColor = '#4f46e5';
  else if (lower.includes('pembe') || lower.includes('gül')) payload.defaultAccentColor = '#e11d48';
  else if (lower.includes('turkuaz')) payload.defaultAccentColor = '#0891b2';
  else if (lower.includes('mavi')) payload.defaultAccentColor = '#2563eb';

  if (lower.includes('karanlık') || lower.includes('koyu')) payload.defaultColorMode = 'dark';
  else if (lower.includes('açık mod') || lower.includes('aydınlık')) payload.defaultColorMode = 'light';
  else if (lower.includes('hibrit') || lower.includes('özel mod')) payload.defaultColorMode = 'custom';

  if (lower.includes('büyük simge') || lower.includes('büyüt')) payload.defaultIconSize = 'large';
  else if (lower.includes('küçük simge') || lower.includes('küçült')) payload.defaultIconSize = 'small';

  if (lower.includes('sola') && (lower.includes('görev') || lower.includes('başlat'))) {
    payload.defaultTaskbarAlign = 'left';
  } else if (lower.includes('orta') && (lower.includes('görev') || lower.includes('başlat'))) {
    payload.defaultTaskbarAlign = 'center';
  }

  if (lower.includes('şafak') || lower.includes('dağ')) payload.defaultWallpaperId = 'wp_alpine_dawn';
  else if (lower.includes('iskandinav') || lower.includes('buz')) payload.defaultWallpaperId = 'wp_nordic_glass';
  else if (lower.includes('kumul') || lower.includes('çöl')) payload.defaultWallpaperId = 'wp_terracotta_dune';

  if (lower.includes('saydamlık kapat') || lower.includes('saydamlığı kapat')) {
    payload.defaultTransparencyEnabled = false;
  } else if (lower.includes('saydamlık aç')) {
    payload.defaultTransparencyEnabled = true;
  }

  // Always make sure an AI update includes tangible visible change if user didn't specify a color/mode
  if (lower.includes('uygulama') || lower.includes('araç') || lower.includes('oyun')) {
    payload.addedStoreApps = [
      {
        name: `v${version} Mini Uygulama`,
        description: `v${version} güncellemesi ile MY Store'a eklendi.`,
        kind: 'html',
        accentHex: payload.defaultAccentColor || '#2563eb',
        html: `<!doctype html><html lang="tr"><body style="margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center"><h1 style="margin:0 0 8px">MY SYSTEM ${version}</h1><p style="opacity:.8;max-width:440px">${prompt.replace(/</g, '&lt;')}</p><button onclick="document.getElementById('c').textContent=Number(document.getElementById('c').textContent)+1" style="margin-top:16px;padding:10px 20px;border-radius:10px;border:0;background:${payload.defaultAccentColor || '#2563eb'};color:#fff;font-weight:600;cursor:pointer">Etkileşim Sayacı: <span id="c">0</span></button></body></html>`,
      },
    ];
    notes.push(`MY Store'a yeni uygulama eklendi: v${version} Mini Uygulama`);
  }

  payload.announcementBanner = prompt.trim().slice(0, 220);
  notes.unshift(prompt.trim());

  if (payload.defaultAccentColor) {
    notes.push(`Sistem vurgu rengi güncellendi (${payload.defaultAccentColor}).`);
  }
  if (payload.defaultColorMode) {
    notes.push(`Tema modu güncellendi (${payload.defaultColorMode}).`);
  }
  if (payload.defaultTaskbarAlign) {
    notes.push(`Görev çubuğu hizalaması güncellendi (${payload.defaultTaskbarAlign}).`);
  }
  if (payload.defaultIconSize) {
    notes.push(`Masaüstü simge boyutu güncellendi (${payload.defaultIconSize}).`);
  }

  return {
    version,
    codename: 'AI Küresel Sürüm',
    notes,
    otaPayload: payload,
    reply: `Tamam! MY SYSTEM ${version} sürümü hazırlandı ve tüm dünyaya yayınlandı.`,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: true, limit: '6mb' }));

  // Public global OS state (OTA updates, MY Store community apps, editable site links)
  app.get('/api/global-state', (_req, res) => {
    const state = readGlobalState();
    res.json({
      ...state,
      hasGeminiKey: Boolean(
        process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
      ),
    });
  });

  // Verify admin PIN (2014)
  app.post('/api/admin/verify', (req, res) => {
    const { pin } = req.body as { pin?: string };
    if (pin === ADMIN_PIN) {
      res.json({ ok: true });
    } else {
      res.status(403).json({ ok: false, error: 'Hatalı yönetici şifresi.' });
    }
  });

  // Manual Global OTA Publish
  app.post('/api/admin/publish-ota', (req, res) => {
    const { pin, version, codename, notes, otaPayload } = req.body as {
      pin?: string;
      version?: string;
      codename?: string;
      notes?: string[];
      otaPayload?: OtaPayload;
    };
    if (pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Yetkisiz işlem.' });
    }
    const state = readGlobalState();
    const cleanVersion = (version || '18.1.0').trim();
    const nextManifest = {
      ...state.manifest,
      version: cleanVersion,
      codename: (codename || 'Küresel OTA').trim(),
      build: `${cleanVersion.replace(/\./g, '')}0.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
      channel: 'Küresel OTA',
      releaseDate: new Date().toISOString().slice(0, 10),
      notes: Array.isArray(notes) && notes.length > 0 ? notes : ['Küresel sistem güncellemesi'],
      otaPayload: otaPayload || state.manifest.otaPayload,
    };
    state.manifest = nextManifest;
    writeGlobalState(state);

    try {
      fs.writeFileSync(PUBLIC_VERSION_FILE, JSON.stringify(nextManifest, null, 2), 'utf-8');
    } catch {
      // ignore if read-only
    }

    return res.json({ ok: true, manifest: nextManifest });
  });

  // Backup restore endpoint so custom MY Store apps survive container restarts
  app.post('/api/custom-apps/restore', (req, res) => {
    const { apps } = req.body as { apps?: CustomGlobalApp[] };
    if (!Array.isArray(apps) || apps.length === 0) {
      return res.json({ ok: true, customApps: readGlobalState().customApps });
    }
    const state = readGlobalState();
    let changed = false;
    for (const incoming of apps) {
      if (!incoming || !incoming.id || !incoming.name) continue;
      if (!state.customApps.some((existing) => existing.id === incoming.id)) {
        state.customApps.push({
          id: String(incoming.id),
          name: String(incoming.name),
          description: String(incoming.description || 'Özel Uygulama'),
          kind: incoming.kind === 'html' ? 'html' : 'url',
          url: incoming.url,
          html: incoming.html,
          accentHex: incoming.accentHex || '#2563eb',
          createdAt: Number(incoming.createdAt) || Date.now(),
        });
        changed = true;
      }
    }
    if (changed) {
      writeGlobalState(state);
    }
    return res.json({ ok: true, customApps: state.customApps });
  });

  // AI-Powered Global OTA Builder ("Yeni sürümde şunlar olacak de, AI yapsın ve dünyaya yayınlasın")
  app.post('/api/admin/ai-ota', async (req, res) => {
    const { pin, prompt, customVersion } = req.body as {
      pin?: string;
      prompt?: string;
      customVersion?: string;
    };
    if (pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Yetkisiz işlem.' });
    }
    const clean = (prompt || '').trim();
    if (!clean) {
      return res.status(400).json({ ok: false, error: 'Güncelleme açıklaması yazın.' });
    }

    const state = readGlobalState();
    let built = buildDeterministicOtaFromPrompt(clean, state.manifest.version, customVersion);

    const ai = getGenAI();
    if (ai) {
      try {
        const modelName =
          state.aiConfig.model && !state.aiConfig.model.includes('hydrogen')
            ? state.aiConfig.model
            : DEFAULT_GEMINI_MODEL;

        const response = await Promise.race([
          ai.models.generateContent({
            model: modelName,
            contents: `Mevcut sürüm: v${state.manifest.version}. Yönetici şu yeni sürümü istiyor: "${clean}".`,
            config: {
              systemInstruction:
                'Sen MY SYSTEM 18 OTA Güncelleme Mimarısın. Yöneticinin isteğine göre gerçek sistem değişiklikleri içeren JSON güncelleme paketi oluştur. Tüm açıklamalar ve kod adları Türkçe olmalıdır. Eğer yönetici yeni uygulama/oyun/araç istiyorsa addedAppName, addedAppDescription ve tam çalışan addedAppHtml alanlarını da doldur.',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  version: { type: Type.STRING, description: 'Mevcut sürümden yüksek yeni sürüm numarası örn 18.2.0' },
                  codename: { type: Type.STRING, description: 'Kısa Türkçe kod adı' },
                  reply: { type: Type.STRING, description: 'Tamam, hazırladım ve yayınladım tarzında Türkçe onay mesajı' },
                  announcementBanner: { type: Type.STRING, description: 'Türkçe sistem güncelleme duyurusu' },
                  defaultAccentColor: { type: Type.STRING, description: 'Hex renk kodu varsa örn #059669' },
                  defaultColorMode: { type: Type.STRING, description: 'dark veya light veya custom' },
                  defaultTaskbarAlign: { type: Type.STRING, description: 'center veya left' },
                  defaultIconSize: { type: Type.STRING, description: 'small veya medium veya large' },
                  defaultWallpaperId: { type: Type.STRING, description: 'wp_bloom_dark, wp_alpine_dawn, wp_nordic_glass veya wp_terracotta_dune' },
                  defaultTransparencyEnabled: { type: Type.BOOLEAN },
                  addedAppName: { type: Type.STRING, description: 'İstendiyse eklenecek yeni uygulama adı' },
                  addedAppDescription: { type: Type.STRING, description: 'Eklenecek yeni uygulama açıklaması' },
                  addedAppHtml: { type: Type.STRING, description: 'Eklenecek yeni uygulamanın tam HTML/CSS/JS kodu' },
                  notes: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: ['version', 'codename', 'reply', 'notes'],
              },
            },
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 7500)),
        ]);

        const parsed = JSON.parse((response.text || '{}').trim()) as {
          version?: string;
          codename?: string;
          reply?: string;
          announcementBanner?: string;
          defaultAccentColor?: string;
          defaultColorMode?: string;
          defaultTaskbarAlign?: string;
          defaultIconSize?: string;
          defaultWallpaperId?: string;
          defaultTransparencyEnabled?: boolean;
          addedAppName?: string;
          addedAppDescription?: string;
          addedAppHtml?: string;
          notes?: string[];
        };

        const mergedPayload: OtaPayload = {
          ...built.otaPayload,
          announcementBanner: parsed.announcementBanner || built.otaPayload.announcementBanner || clean,
        };
        if (parsed.defaultAccentColor && /^#[0-9a-f]{6}$/i.test(parsed.defaultAccentColor)) {
          mergedPayload.defaultAccentColor = parsed.defaultAccentColor;
        }
        if (
          parsed.defaultColorMode === 'dark' ||
          parsed.defaultColorMode === 'light' ||
          parsed.defaultColorMode === 'custom'
        ) {
          mergedPayload.defaultColorMode = parsed.defaultColorMode;
        }
        if (parsed.defaultTaskbarAlign === 'center' || parsed.defaultTaskbarAlign === 'left') {
          mergedPayload.defaultTaskbarAlign = parsed.defaultTaskbarAlign;
        }
        if (
          parsed.defaultIconSize === 'small' ||
          parsed.defaultIconSize === 'medium' ||
          parsed.defaultIconSize === 'large'
        ) {
          mergedPayload.defaultIconSize = parsed.defaultIconSize;
        }
        if (
          parsed.defaultWallpaperId &&
          ['wp_bloom_dark', 'wp_alpine_dawn', 'wp_nordic_glass', 'wp_terracotta_dune'].includes(
            parsed.defaultWallpaperId
          )
        ) {
          mergedPayload.defaultWallpaperId = parsed.defaultWallpaperId;
        }
        if (typeof parsed.defaultTransparencyEnabled === 'boolean') {
          mergedPayload.defaultTransparencyEnabled = parsed.defaultTransparencyEnabled;
        }
        if (parsed.addedAppName && parsed.addedAppHtml) {
          mergedPayload.addedStoreApps = [
            {
              name: parsed.addedAppName.trim(),
              description: (parsed.addedAppDescription || `${parsed.addedAppName} AI OTA Uygulaması`).trim(),
              kind: 'html',
              html: parsed.addedAppHtml,
              accentHex: mergedPayload.defaultAccentColor || '#2563eb',
            },
          ];
        }

        const candidateVer = (customVersion || parsed.version || built.version).trim();
        built = {
          version: candidateVer !== state.manifest.version ? candidateVer : built.version,
          codename: parsed.codename || built.codename,
          notes: parsed.notes && parsed.notes.length > 0 ? parsed.notes : built.notes,
          otaPayload: mergedPayload,
          reply: parsed.reply || built.reply,
        };
      } catch {
        // seamlessly use deterministic builder if Gemini 429 or timeout
      }
    }

    // If OTA payload brings new Store apps, also publish them into state.customApps
    if (built.otaPayload.addedStoreApps && built.otaPayload.addedStoreApps.length > 0) {
      for (const appSpec of built.otaPayload.addedStoreApps) {
        if (!state.customApps.some((c) => c.name === appSpec.name)) {
          state.customApps.push({
            id: 'capp_ota_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
            name: appSpec.name,
            description: appSpec.description,
            kind: appSpec.kind,
            url: appSpec.url,
            html: appSpec.html,
            accentHex: appSpec.accentHex || '#2563eb',
            createdAt: Date.now(),
          });
        }
      }
    }

    const nextManifest = {
      ...state.manifest,
      version: built.version,
      codename: built.codename,
      build: `${built.version.replace(/\./g, '')}0.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
      channel: 'Küresel OTA',
      releaseDate: new Date().toISOString().slice(0, 10),
      notes: built.notes,
      otaPayload: built.otaPayload,
    };
    state.manifest = nextManifest;
    writeGlobalState(state);

    try {
      fs.writeFileSync(PUBLIC_VERSION_FILE, JSON.stringify(nextManifest, null, 2), 'utf-8');
    } catch {
      // ignore
    }

    return res.json({
      ok: true,
      manifest: nextManifest,
      customApps: state.customApps,
      reply: built.reply,
    });
  });

  // Reset global OTA manifest back to v18.0.0
  app.post('/api/admin/reset-ota', (req, res) => {
    const { pin } = req.body as { pin?: string };
    if (pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Yetkisiz işlem.' });
    }
    const state = readGlobalState();
    const initial = createInitialGlobalState();
    state.manifest = initial.manifest;
    writeGlobalState(state);
    return res.json({ ok: true, manifest: state.manifest });
  });

  // Add global HTML or URL custom app -> Published to MY Store for users to download
  app.post('/api/admin/custom-apps', (req, res) => {
    const { pin, name, description, kind, url, html, accentHex } = req.body as {
      pin?: string;
      name?: string;
      description?: string;
      kind?: 'url' | 'html';
      url?: string;
      html?: string;
      accentHex?: string;
    };
    if (pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Yetkisiz işlem.' });
    }
    if (!name?.trim()) {
      return res.status(400).json({ ok: false, error: 'Uygulama adı zorunludur.' });
    }
    const state = readGlobalState();
    const newApp: CustomGlobalApp = {
      id: 'capp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
      name: name.trim(),
      description: (description || (kind === 'html' ? 'Özel HTML Uygulaması' : 'Web Uygulaması')).trim(),
      kind: kind === 'html' ? 'html' : 'url',
      url: kind === 'url' ? (url || 'https://example.com').trim() : undefined,
      html: kind === 'html' ? html || '<h1>Merhaba MY SYSTEM 18</h1>' : undefined,
      accentHex: accentHex || '#2563eb',
      createdAt: Date.now(),
    };
    state.customApps.push(newApp);
    writeGlobalState(state);
    return res.json({ ok: true, app: newApp, customApps: state.customApps });
  });

  app.delete('/api/admin/custom-apps/:id', (req, res) => {
    const pin = req.headers['x-admin-pin'] as string | undefined;
    if (pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Yetkisiz işlem.' });
    }
    const state = readGlobalState();
    state.customApps = state.customApps.filter((a) => a.id !== req.params.id);
    writeGlobalState(state);
    return res.json({ ok: true, customApps: state.customApps });
  });

  app.post('/api/admin/site-links', (req, res) => {
    const { pin, siteLinks } = req.body as {
      pin?: string;
      siteLinks?: Partial<SiteLinksConfig>;
    };
    if (pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Yetkisiz işlem.' });
    }
    const state = readGlobalState();
    state.siteLinks = { ...state.siteLinks, ...(siteLinks || {}) };
    writeGlobalState(state);
    return res.json({ ok: true, siteLinks: state.siteLinks });
  });

  app.post('/api/admin/ai-config', (req, res) => {
    const { pin, aiConfig } = req.body as {
      pin?: string;
      aiConfig?: Partial<AIConfig>;
    };
    if (pin !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Yetkisiz işlem.' });
    }
    const state = readGlobalState();
    const nextCfg = { ...state.aiConfig, ...(aiConfig || {}) };
    if (nextCfg.model?.includes('hydrogen')) {
      nextCfg.model = DEFAULT_GEMINI_MODEL;
    }
    state.aiConfig = nextCfg;
    writeGlobalState(state);
    return res.json({ ok: true, aiConfig: state.aiConfig });
  });

  // Live City Weather Endpoint (Open-Meteo Geocoding + Forecast in Turkish)
  const describeWeatherCodeTr = (code: number): string => {
    if (code === 0) return 'Açık ve Güneşli';
    if (code <= 2) return 'Az Bulutlu';
    if (code === 3) return 'Çok Bulutlu';
    if (code === 45 || code === 48) return 'Sisli';
    if (code >= 51 && code <= 57) return 'Çiseleyen Yağmur';
    if (code >= 61 && code <= 67) return 'Yağmurlu';
    if (code >= 71 && code <= 77) return 'Kar Yağışlı';
    if (code >= 80 && code <= 82) return 'Sağanak Yağışlı';
    if (code >= 95) return 'Gök Gürültülü Sağanak';
    return 'Parçalı Bulutlu';
  };

  app.get('/api/weather', async (req, res) => {
    const cityInput = String(req.query.city || 'İstanbul').trim() || 'İstanbul';
    try {
      const geoRes = await fetchWithTimeout(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityInput)}&count=1&language=tr&format=json`,
        { headers: { 'User-Agent': 'MYSYSTEM18/1.0' } },
        4500
      );
      if (geoRes.ok) {
        const geoData = (await geoRes.json()) as {
          results?: Array<{ name?: string; latitude: number; longitude: number }>;
        };
        const place = geoData.results?.[0];
        if (place) {
          const fcRes = await fetchWithTimeout(
            `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`,
            { headers: { 'User-Agent': 'MYSYSTEM18/1.0' } },
            4500
          );
          if (fcRes.ok) {
            const fcData = (await fcRes.json()) as {
              current?: {
                temperature_2m?: number;
                relative_humidity_2m?: number;
                weather_code?: number;
                wind_speed_10m?: number;
              };
            };
            const c = fcData.current;
            if (c && typeof c.temperature_2m === 'number') {
              return res.json({
                city: place.name || cityInput,
                temp: Math.round(c.temperature_2m),
                condition: describeWeatherCodeTr(Number(c.weather_code || 0)),
                windKmh: Math.round(Number(c.wind_speed_10m || 10)),
                humidity: Math.round(Number(c.relative_humidity_2m || 55)),
                code: Number(c.weather_code || 0),
                updatedAt: Date.now(),
              });
            }
          }
        }
      }
    } catch {
      // Fallback below
    }

    // Deterministic offline fallback based on city name hash
    const hash = Array.from(cityInput).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return res.json({
      city: cityInput,
      temp: 12 + (hash % 15),
      condition: ['Parçalı Bulutlu', 'Açık ve Güneşli', 'Az Bulutlu', 'Hafif Rüzgarlı'][hash % 4],
      windKmh: 8 + (hash % 14),
      humidity: 45 + (hash % 30),
      code: 2,
      updatedAt: Date.now(),
    });
  });

  // Live Web Search Endpoint (DuckDuckGo TR + Wikipedia TR + Optional Gemini 3 strictly in Turkish)
  app.post('/api/search', async (req, res) => {
    const { query } = req.body as { query?: string };
    const clean = (query || '').trim();
    if (!clean) {
      return res.status(400).json({ error: 'Arama sorgusu boş olamaz.' });
    }

    const fallbackData = await liveWebSearchFallback(clean);
    const ai = getGenAI();
    const state = readGlobalState();

    if (ai && state.aiConfig.enabled) {
      try {
        const modelName =
          state.aiConfig.model && !state.aiConfig.model.includes('hydrogen')
            ? state.aiConfig.model
            : DEFAULT_GEMINI_MODEL;
        const response = await Promise.race([
          ai.models.generateContent({
            model: modelName,
            contents: `Sorgu: "${clean}". Bu web araması için YALNIZCA Türkçe, anlaşılır, kısa bir bilgi özeti yaz. Kesinlikle İngilizce cümle veya yabancı altbilgi metni kullanma.`,
            config: {
              systemInstruction:
                'Sen MY Ara Türkçe arama motoru özetleyicisisin. Tüm cevapların yüzde yüz Türkçe olmalıdır.',
              tools: [{ googleSearch: {} }],
            },
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5500)),
        ]);

        const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const aiResults = chunks
          .filter((c) => c.web?.uri)
          .map((c) => ({
            title: c.web?.title || c.web?.uri || 'Web Sonucu',
            url: c.web?.uri || '',
          }));

        return res.json({
          query: clean,
          summary: response.text?.trim() || fallbackData.summary,
          results: aiResults.length > 0 ? aiResults : fallbackData.results,
          source: 'gemini-3',
        });
      } catch {
        // Fallback smoothly to live DuckDuckGo TR + Wikipedia TR search
      }
    }

    return res.json({
      query: clean,
      summary: fallbackData.summary,
      results: fallbackData.results,
      source: 'live-web',
    });
  });

  // Live News Endpoint (Direct Turkish Publisher RSS feeds — never uses broken news.google.com/rss/articles redirects)
  app.post('/api/news', async (req, res) => {
    const { categoryId, query, label } = req.body as {
      categoryId?: string;
      query?: string;
      label?: string;
    };
    const clean = (query || 'Türkiye son dakika').trim();

    let articles: Array<{ title: string; url: string; pubDate?: string; source?: string }> = [];
    try {
      articles = await fetchDirectTurkishNews(categoryId, clean);
    } catch {
      const web = await liveWebSearchFallback(clean);
      articles = web.results.map((r) => ({ title: r.title, url: r.url, source: 'Web' }));
    }

    let summary = `${label || 'Güncel'} kategorisi için ${articles.length} canlı Türkçe haber kaynağı derlendi.`;
    const ai = getGenAI();
    const state = readGlobalState();

    if (ai && state.aiConfig.enabled && articles.length > 0) {
      try {
        const headlineList = articles
          .slice(0, 6)
          .map((a) => `- ${a.title}`)
          .join('\n');
        const modelName =
          state.aiConfig.model && !state.aiConfig.model.includes('hydrogen')
            ? state.aiConfig.model
            : DEFAULT_GEMINI_MODEL;
        const aiRes = await Promise.race([
          ai.models.generateContent({
            model: modelName,
            contents: `Şu haber başlıklarını yalnızca Türkçe olarak 3 cümlelik akıcı bir gündem özeti haline getir:\n${headlineList}`,
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        if (aiRes.text?.trim()) {
          summary = aiRes.text.trim();
        }
      } catch {
        // ignore quota errors; live RSS articles still display cleanly
      }
    }

    return res.json({ summary, articles });
  });

  // Domain Cookie Jar for authenticated / multi-step proxied browsing sessions
  const proxyCookieJar = new Map<string, Map<string, string>>();

  const getCookiesForHost = (hostname: string): string => {
    const key = hostname.replace(/^www\./, '').toLowerCase();
    const jar = proxyCookieJar.get(key);
    if (!jar || jar.size === 0) return '';
    return Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  };

  const storeSetCookies = (hostname: string, headers: Headers) => {
    const key = hostname.replace(/^www\./, '').toLowerCase();
    const hdrAny = headers as unknown as { getSetCookie?: () => string[] };
    const list =
      typeof hdrAny.getSetCookie === 'function'
        ? hdrAny.getSetCookie()
        : headers.get('set-cookie')
          ? [headers.get('set-cookie')!]
          : [];
    if (list.length === 0) return;
    let jar = proxyCookieJar.get(key);
    if (!jar) {
      jar = new Map<string, string>();
      proxyCookieJar.set(key, jar);
    }
    for (const rawCookie of list) {
      const firstPart = rawCookie.split(';')[0]?.trim();
      const eqIdx = firstPart?.indexOf('=') ?? -1;
      if (firstPart && eqIdx > 0) {
        const name = firstPart.slice(0, eqIdx).trim();
        const val = firstPart.slice(eqIdx + 1).trim();
        jar.set(name, val);
      }
    }
  };

  // API/XHR Proxy Bridge for SPA sites loaded inside MY Tarayıcı / Google Chrome
  app.all('/api/proxy-fetch', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      return res.status(400).json({ error: 'Geçersiz URL' });
    }
    try {
      const parsed = new URL(rawUrl);
      const method = req.method.toUpperCase();
      const jarCookie = getCookiesForHost(parsed.hostname);
      const forwardHeaders: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        Origin: parsed.origin,
        Referer: parsed.origin + '/',
        ...(jarCookie ? { Cookie: jarCookie } : {}),
      };
      if (req.headers['content-type']) {
        forwardHeaders['Content-Type'] = String(req.headers['content-type']);
      }
      const opts: RequestInit = { method, headers: forwardHeaders, redirect: 'follow' };
      if (!['GET', 'HEAD'].includes(method) && req.body) {
        opts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }
      const upstream = await fetchWithTimeout(rawUrl, opts, 10000);
      storeSetCookies(parsed.hostname, upstream.headers);
      const ct = upstream.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', ct);
      res.status(upstream.status);
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.send(buf);
    } catch {
      return res.status(502).json({ error: 'Proxy API isteği başarısız.' });
    }
  });

  // Universal Web Proxy for MY Tarayıcı, Google Chrome & WebPortalApp
  const buildBrowserBridgeScript = (finalUrl: string) => `
<script>
(function() {
  var BASE_URL = ${JSON.stringify(finalUrl)};
  var TARGET_ORIGIN = (function(){ try { return new URL(BASE_URL).origin; } catch(e){ return ''; } })();
  var DL_EXT = /\\.(zip|rar|7z|tar|gz|bz2|xz|exe|msi|apk|dmg|iso|bin|dll|pdf|doc|docx|xls|xlsx|ppt|pptx|mp3|wav|ogg|m4a|flac|mp4|webm|mov|mkv|avi|png|jpg|jpeg|webp|gif|svg|csv|tsv|json|txt)$/i;

  function post(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }

  function resolveUrl(raw) {
    try { return new URL(raw, document.baseURI || BASE_URL).href; } catch (e) { return raw; }
  }

  function rewriteApiUrl(urlStr) {
    try {
      if (!urlStr || typeof urlStr !== 'string') return urlStr;
      if (urlStr.startsWith('/api/proxy') || urlStr.startsWith('data:') || urlStr.startsWith('blob:')) return urlStr;
      var abs = new URL(urlStr, BASE_URL);
      if (/^https?:$/i.test(abs.protocol) && abs.origin !== window.location.origin) {
        return '/api/proxy-fetch?url=' + encodeURIComponent(abs.href);
      }
    } catch (e) {}
    return urlStr;
  }

  try {
    Object.defineProperty(window, 'frameElement', { get: function() { return null; } });
  } catch (e) {}

  // Guard History API against origin mismatch inside iframe
  try {
    var origPush = history.pushState.bind(history);
    var origReplace = history.replaceState.bind(history);
    history.pushState = function(state, title, url) {
      try {
        if (url) {
          var nextAbs = resolveUrl(String(url));
          if (/^https?:\\/\\//i.test(nextAbs)) post({ type: 'my-browser-meta', title: document.title || '', url: nextAbs });
        }
        return origPush(state, title, undefined);
      } catch (e) {}
    };
    history.replaceState = function(state, title, url) {
      try { return origReplace(state, title, undefined); } catch (e) {}
    };
  } catch (e) {}

  // Intercept fetch & XHR calls made by JS sites to cross-origin APIs
  try {
    var nativeFetch = window.fetch;
    if (nativeFetch) {
      window.fetch = function(input, init) {
        try {
          if (typeof input === 'string') {
            return nativeFetch.call(window, rewriteApiUrl(input), init);
          }
          if (input && typeof input === 'object' && input.url) {
            var rewritten = rewriteApiUrl(input.url);
            if (rewritten !== input.url) {
              return nativeFetch.call(window, new Request(rewritten, input), init);
            }
          }
        } catch (e) {}
        return nativeFetch.call(window, input, init);
      };
    }
    var origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof url === 'string') args[1] = rewriteApiUrl(url);
      return origXhrOpen.apply(this, args);
    };
  } catch (e) {}

  function isDownloadHref(url, hasDownloadAttr) {
    if (hasDownloadAttr) return true;
    try {
      var u = new URL(url);
      if (DL_EXT.test(u.pathname)) return true;
    } catch (e) {}
    return false;
  }

  // Override window.open so sites opening popups/new tabs open inside MY Tarayıcı tabs
  window.open = function(url) {
    if (url) {
      var resolved = resolveUrl(String(url));
      if (/^https?:\\/\\//i.test(resolved)) {
        post({ type: 'my-browser-open-tab', url: resolved });
      }
    }
    return { focus: function(){}, close: function(){}, closed: false };
  };

  document.addEventListener('click', function(e) {
    if (e.defaultPrevented) return;
    var el = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (!el) return;
    var rawHref = el.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#') || /^javascript:/i.test(rawHref) || /^mailto:/i.test(rawHref) || /^tel:/i.test(rawHref)) {
      return;
    }
    var resolved = resolveUrl(el.href || rawHref);
    if (!/^https?:\\/\\//i.test(resolved)) return;

    var wantsNewTab =
      el.target === '_blank' ||
      el.target === '_new' ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.button === 1;

    if (isDownloadHref(resolved, el.hasAttribute('download'))) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'my-browser-download', url: resolved, fileName: el.getAttribute('download') || '' });
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (wantsNewTab) {
      post({ type: 'my-browser-open-tab', url: resolved });
    } else {
      post({ type: 'my-browser-navigate', url: resolved });
    }
  }, true);

  document.addEventListener('auxclick', function(e) {
    if (e.button !== 1) return;
    var el = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (!el) return;
    var resolved = resolveUrl(el.href || el.getAttribute('href') || '');
    if (/^https?:\\/\\//i.test(resolved)) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'my-browser-open-tab', url: resolved });
    }
  }, true);

  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var actionAttr = form.getAttribute('action') || '';
    var actionUrl = resolveUrl(actionAttr || BASE_URL);
    if (!/^https?:\\/\\//i.test(actionUrl)) return;
    var method = (form.getAttribute('method') || 'get').toLowerCase();

    if (method === 'get') {
      e.preventDefault();
      e.stopPropagation();
      try {
        var u = new URL(actionUrl);
        var fd = new FormData(form);
        fd.forEach(function(val, key) {
          if (typeof val === 'string') u.searchParams.append(key, val);
        });
        if (form.target === '_blank') {
          post({ type: 'my-browser-open-tab', url: u.href });
        } else {
          post({ type: 'my-browser-navigate', url: u.href });
        }
      } catch (err) {}
    } else {
      form.action = '/api/proxy?url=' + encodeURIComponent(actionUrl);
    }
  }, true);

  function syncMeta() {
    post({ type: 'my-browser-meta', title: document.title || '', url: BASE_URL });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncMeta);
  } else {
    syncMeta();
  }
  window.addEventListener('load', syncMeta);
})();
</script>`;

  const renderGoogleProxyPage = async (query: string, reqUrl: string) => {
    const cleanQ = query.trim();
    if (!cleanQ) {
      return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Google</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#fff;color:#202124;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:90vh;padding:24px}
.logo{font-size:64px;font-weight:700;letter-spacing:-2px;margin-bottom:24px}
.g1{color:#4285F4}.g2{color:#EA4335}.g3{color:#FBBC05}.g4{color:#34A853}
form{width:100%;max-width:580px;display:flex;gap:8px}
input{flex:1;padding:13px 18px;border:1px solid #dfe1e5;border-radius:24px;font-size:15px;outline:none;box-shadow:0 1px 6px rgba(32,33,36,.12)}
button{padding:12px 22px;border:0;border-radius:20px;background:#1a73e8;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.links{margin-top:20px;display:flex;gap:12px;flex-wrap:wrap;justify-content:center;font-size:13px}
.links a{color:#1a73e8;text-decoration:none;padding:6px 12px;border-radius:8px;background:#f8f9fa}
</style></head><body>
<div class="logo"><span class="g1">G</span><span class="g2">o</span><span class="g3">o</span><span class="g1">g</span><span class="g4">l</span><span class="g2">e</span></div>
<form action="https://www.google.com/search" method="GET">
<input type="text" name="q" placeholder="Google'da ara veya URL yaz..." autofocus />
<button type="submit">Google'da Ara</button>
</form>
<div class="links">
<a href="https://news.google.com/?hl=tr&gl=TR&ceid=TR:tr">Haberler</a>
<a href="https://tr.wikipedia.org">Vikipedi TR</a>
<a href="https://mertyusufdeniz.tr">Mertyusufdeniz</a>
<a href="https://hdfilix.mertyusufdeniz.tr">HDFilix</a>
</div>
${buildBrowserBridgeScript('https://www.google.com/?hl=tr')}
</body></html>`;
    }

    const web = await liveWebSearchFallback(cleanQ);
    let aiSummary = '';
    let results = web.results;
    const ai = getGenAI();
    const state = readGlobalState();

    if (ai && state.aiConfig.enabled) {
      try {
        const modelName =
          state.aiConfig.model && !state.aiConfig.model.includes('hydrogen')
            ? state.aiConfig.model
            : DEFAULT_GEMINI_MODEL;
        const r = await Promise.race([
          ai.models.generateContent({
            model: modelName,
            contents: `Kullanıcının Google araması: "${cleanQ}". Kısa, net Türkçe özet ver.`,
            config: { tools: [{ googleSearch: {} }] },
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4500)),
        ]);
        if (r.text?.trim()) aiSummary = r.text.trim();
        const chunks = r.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const gLinks = chunks
          .filter((c) => c.web?.uri)
          .map((c) => ({ title: c.web?.title || c.web?.uri || 'Web', url: c.web?.uri || '', snippet: '' }));
        if (gLinks.length > 0) {
          results = [...gLinks, ...web.results.filter((w) => !gLinks.some((g) => g.url === w.url))];
        }
      } catch {
        // Fallback gracefully to DuckDuckGo + Wikipedia
      }
    }

    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const itemsHtml = results
      .map(
        (r) => `<div class="res">
  <div class="url">${esc(r.url)}</div>
  <div class="title-row">
    <a class="title" href="${esc(r.url)}">${esc(r.title)}</a>
    <a class="ntab" href="${esc(r.url)}" target="_blank">Yeni Sekmede Aç ↗</a>
    <a class="dl" href="${esc(r.url)}" download>İndir</a>
  </div>
  ${r.snippet ? `<div class="snip">${esc(r.snippet)}</div>` : ''}
</div>`
      )
      .join('\n');

    return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${esc(cleanQ)} - Google'da Ara</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#fff;color:#202124}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ebebeb;padding:14px 24px;display:flex;align-items:center;gap:20px;z-index:10}
.brand{font-size:24px;font-weight:700;text-decoration:none;letter-spacing:-1px}
.g1{color:#4285F4}.g2{color:#EA4335}.g3{color:#FBBC05}.g4{color:#34A853}
form{flex:1;max-width:620px;display:flex;gap:8px}
input{flex:1;padding:10px 16px;border:1px solid #dfe1e5;border-radius:22px;font-size:14px;outline:none}
button{padding:9px 18px;border:0;border-radius:18px;background:#1a73e8;color:#fff;font-weight:600;cursor:pointer}
main{max-width:740px;margin:0 auto;padding:20px 24px 48px}
.ai-box{background:#f0f6ff;border:1px solid #d2e3fc;border-radius:14px;padding:14px 16px;margin-bottom:22px;font-size:13.5px;line-height:1.55;white-space:pre-wrap}
.res{margin-bottom:22px}
.url{font-size:12px;color:#3c4043;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 4px}
.title{font-size:18px;color:#1a0dab;text-decoration:none;font-weight:500}
.title:hover{text-decoration:underline}
.ntab,.dl{font-size:11px;padding:2px 8px;border-radius:6px;background:#f1f3f4;color:#3c4043;text-decoration:none}
.ntab:hover,.dl:hover{background:#e2e6ea}
.snip{font-size:13px;color:#4d5156;line-height:1.5}
</style></head><body>
<header>
  <a class="brand" href="https://www.google.com/?hl=tr"><span class="g1">G</span><span class="g2">o</span><span class="g3">o</span><span class="g1">g</span><span class="g4">l</span><span class="g2">e</span></a>
  <form action="https://www.google.com/search" method="GET">
    <input type="text" name="q" value="${esc(cleanQ)}" />
    <button type="submit">Ara</button>
  </form>
</header>
<main>
  ${aiSummary ? `<div class="ai-box"><strong>Google Arama Özeti</strong>\n${esc(aiSummary)}</div>` : ''}
  ${itemsHtml || '<p>Sonuç bulunamadı.</p>'}
</main>
${buildBrowserBridgeScript(reqUrl)}
</body></html>`;
  };

  // Dedicated Interactive YouTube Proxy Renderer (never renders blank skeleton shimmer)
  interface YouTubeVideoItem {
    id: string;
    title: string;
    channel: string;
    meta?: string;
    thumb: string;
  }

  const extractYouTubeVideos = async (searchQuery: string): Promise<YouTubeVideoItem[]> => {
    const videos: YouTubeVideoItem[] = [];
    const seen = new Set<string>();
    const effectiveQuery = searchQuery.trim() || 'türkiye popüler videolar müzik teknoloji';
    const targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(effectiveQuery)}&hl=tr&gl=TR`;

    try {
      const res = await fetchWithTimeout(
        targetUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Accept-Language': 'tr-TR,tr;q=0.9',
            Cookie: 'CONSENT=YES+TR.tr+V14+BX; PREF=hl=tr&gl=TR',
          },
        },
        7000
      );
      if (res.ok) {
        const html = await res.text();
        const dataMatch = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|var )/i);
        if (dataMatch?.[1]) {
          try {
            const walk = (node: unknown) => {
              if (!node || typeof node !== 'object' || videos.length >= 24) return;
              if (Array.isArray(node)) {
                node.forEach(walk);
                return;
              }
              const obj = node as Record<string, unknown>;
              const vr = (
                obj.videoRenderer ||
                obj.gridVideoRenderer ||
                obj.compactVideoRenderer ||
                obj.playlistVideoRenderer
              ) as Record<string, unknown> | undefined;
              if (vr && typeof vr.videoId === 'string' && !seen.has(vr.videoId)) {
                seen.add(vr.videoId);
                const titleRuns = (vr.title as { runs?: Array<{ text?: string }>; simpleText?: string }) || {};
                const title =
                  titleRuns.simpleText ||
                  (titleRuns.runs ? titleRuns.runs.map((r) => r.text || '').join('') : '') ||
                  'YouTube Videosu';
                const ownerRuns = (vr.ownerText as { runs?: Array<{ text?: string }> })?.runs
                  || (vr.shortBylineText as { runs?: Array<{ text?: string }> })?.runs;
                const channel = ownerRuns?.[0]?.text || 'YouTube Kanalı';
                const lengthText = (vr.lengthText as { simpleText?: string })?.simpleText || '';
                const viewsText = (vr.shortViewCountText as { simpleText?: string })?.simpleText || '';
                videos.push({
                  id: vr.videoId,
                  title,
                  channel,
                  meta: [lengthText, viewsText].filter(Boolean).join(' · '),
                  thumb: `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
                });
              }
              Object.values(obj).forEach(walk);
            };
            walk(JSON.parse(dataMatch[1]));
          } catch {
            // fallback to regex
          }
        }
        // Lightweight regex sweep if JSON tree wasn't matched
        if (videos.length === 0) {
          const idMatches = Array.from(
            html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,400}?"title":\{"runs":\[\{"text":"([^"]+)"/g)
          );
          for (const m of idMatches) {
            if (!seen.has(m[1]) && videos.length < 18) {
              seen.add(m[1]);
              videos.push({
                id: m[1],
                title: m[2].replace(/\\u0026/g, '&'),
                channel: 'YouTube',
                thumb: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`,
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }

    // Fallback via DuckDuckGo TR video links if YouTube IP-gated
    if (videos.length === 0) {
      const ddg = await liveWebSearchFallback(
        `site:youtube.com/watch ${searchQuery || 'türkiye müzik teknoloji belgesel'}`
      );
      for (const r of ddg.results) {
        const m = r.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (m?.[1] && !seen.has(m[1])) {
          seen.add(m[1]);
          videos.push({
            id: m[1],
            title: r.title.replace(/ - YouTube$/i, ''),
            channel: 'YouTube',
            thumb: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`,
          });
        }
      }
    }

    return videos;
  };

  const renderYouTubeProxyPage = async (parsedUrl: URL) => {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const pathName = parsedUrl.pathname;
    let videoId = parsedUrl.searchParams.get('v') || '';
    if (!videoId && parsedUrl.hostname === 'youtu.be') {
      videoId = pathName.replace(/^\//, '').split('/')[0] || '';
    }
    if (!videoId && /^\/(shorts|embed|live)\/([^/?]+)/i.test(pathName)) {
      videoId = pathName.match(/^\/(shorts|embed|live)\/([^/?]+)/i)?.[2] || '';
    }

    const searchQ = parsedUrl.searchParams.get('search_query') || '';
    const related = await extractYouTubeVideos(searchQ || (videoId ? 'türkiye popüler' : ''));

    let activeTitle = 'YouTube';
    let activeAuthor = '';
    if (videoId) {
      try {
        const oeRes = await fetchWithTimeout(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
          {},
          3500
        );
        if (oeRes.ok) {
          const oe = (await oeRes.json()) as { title?: string; author_name?: string };
          activeTitle = oe.title || 'YouTube Video';
          activeAuthor = oe.author_name || '';
        }
      } catch {
        // ignore
      }
    }

    const cardsHtml = related
      .map(
        (v) => `<a class="card" href="https://www.youtube.com/watch?v=${esc(v.id)}">
  <img src="${esc(v.thumb)}" alt="${esc(v.title)}" loading="lazy" />
  <div class="info">
    <div class="vtitle">${esc(v.title)}</div>
    <div class="vmeta">${esc(v.channel)}${v.meta ? ' · ' + esc(v.meta) : ''}</div>
  </div>
</a>`
      )
      .join('\n');

    return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${esc(activeTitle)} - YouTube</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0f0f0f;color:#f1f1f1}
  header{position:sticky;top:0;z-index:20;background:#0f0f0f;border-bottom:1px solid #272727;padding:10px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .logo{display:flex;align-items:center;gap:7px;text-decoration:none;color:#fff;font-weight:800;font-size:17px;letter-spacing:-0.3px}
  .play-badge{background:#ff0000;color:#fff;padding:3px 9px;border-radius:7px;font-size:12px}
  form{flex:1;max-width:560px;display:flex;gap:8px;margin:0 auto}
  input{flex:1;padding:9px 16px;border-radius:20px;border:1px solid #303030;background:#121212;color:#fff;font-size:14px;outline:none}
  input:focus{border-color:#3ea6ff}
  button{padding:9px 18px;border-radius:20px;border:1px solid #303030;background:#222;color:#fff;font-weight:600;cursor:pointer}
  button:hover{background:#333}
  .chips{display:flex;gap:8px;padding:10px 18px;overflow-x:auto;border-bottom:1px solid #202020}
  .chip{text-decoration:none;color:#e5e5e5;background:#272727;padding:6px 12px;border-radius:8px;font-size:12px;white-space:nowrap}
  .chip:hover{background:#3a3a3a}
  main{max-width:1280px;margin:0 auto;padding:18px}
  .player-wrap{background:#000;border-radius:14px;overflow:hidden;border:1px solid #272727;margin-bottom:18px}
  .player-aspect{position:relative;padding-top:56.25%}
  .player-aspect iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
  .now-playing{padding:14px 16px;background:#181818}
  .now-playing h1{margin:0 0 4px;font-size:18px}
  .now-playing p{margin:0;color:#aaa;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
  .card{text-decoration:none;color:inherit;background:#181818;border:1px solid #262626;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;transition:transform .15s,border-color .15s}
  .card:hover{transform:translateY(-2px);border-color:#3ea6ff}
  .card img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#1f1f1f}
  .info{padding:10px 12px}
  .vtitle{font-size:13.5px;font-weight:600;line-height:1.35;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .vmeta{font-size:12px;color:#aaa}
</style></head><body>
<header>
  <a class="logo" href="https://www.youtube.com/"><span class="play-badge">▶</span><span>YouTube</span></a>
  <form action="https://www.youtube.com/results" method="GET">
    <input type="text" name="search_query" value="${esc(searchQ)}" placeholder="YouTube'da video veya kanal ara..." />
    <button type="submit">Ara</button>
  </form>
</header>
<div class="chips">
  <a class="chip" href="https://www.youtube.com/results?search_query=T%C3%BCrkiye+M%C3%BCzik">Müzik</a>
  <a class="chip" href="https://www.youtube.com/results?search_query=Teknoloji+inceleme">Teknoloji</a>
  <a class="chip" href="https://www.youtube.com/results?search_query=Oyun+videolar%C4%B1">Oyun</a>
  <a class="chip" href="https://www.youtube.com/results?search_query=Bilim+ve+Belgesel">Bilim & Belgesel</a>
  <a class="chip" href="https://www.youtube.com/results?search_query=Canl%C4%B1+Haber">Canlı Haber</a>
</div>
<main>
  ${
    videoId
      ? `<div class="player-wrap">
    <div class="player-aspect">
      <iframe src="https://www.youtube-nocookie.com/embed/${esc(videoId)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>
    </div>
    <div class="now-playing">
      <h1>${esc(activeTitle)}</h1>
      ${activeAuthor ? `<p>${esc(activeAuthor)}</p>` : ''}
    </div>
  </div>`
      : ''
  }
  <div class="grid">
    ${cardsHtml || '<p style="color:#aaa">Video aramak için yukarıdaki arama kutusunu kullanın.</p>'}
  </div>
</main>
${buildBrowserBridgeScript(parsedUrl.href)}
</body></html>`;
  };

  app.all('/api/proxy', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      return res.status(400).send('Geçersiz URL.');
    }

    // Intercept Google Search & YouTube interactively inside MY Tarayıcı
    try {
      const parsedTarget = new URL(rawUrl);
      if (/(^|\.)google\.(com|com\.tr|de|co\.uk)$/i.test(parsedTarget.hostname)) {
        if (parsedTarget.pathname === '/search' || parsedTarget.searchParams.has('q')) {
          const q = parsedTarget.searchParams.get('q') || '';
          const html = await renderGoogleProxyPage(q, rawUrl);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(html);
        }
        if (parsedTarget.pathname === '/' || parsedTarget.pathname === '/webhp') {
          const html = await renderGoogleProxyPage('', rawUrl);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(html);
        }
      }

      if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(parsedTarget.hostname)) {
        const html = await renderYouTubeProxyPage(parsedTarget);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }
    } catch {
      // continue normal fetch
    }

    try {
      const targetParsed = new URL(rawUrl);
      const jarCookie = getCookiesForHost(targetParsed.hostname);
      const method = req.method === 'POST' ? 'POST' : 'GET';
      const fetchOpts: RequestInit = {
        method,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          ...(jarCookie ? { Cookie: jarCookie } : {}),
        },
        redirect: 'follow',
      };
      if (method === 'POST' && req.body && typeof req.body === 'object') {
        const params = new URLSearchParams();
        Object.entries(req.body as Record<string, unknown>).forEach(([k, v]) => {
          params.append(k, String(v ?? ''));
        });
        fetchOpts.body = params.toString();
        (fetchOpts.headers as Record<string, string>)['Content-Type'] =
          'application/x-www-form-urlencoded';
      }

      const upstream = await fetchWithTimeout(rawUrl, fetchOpts, 11000);
      const finalUrl = upstream.url || rawUrl;
      const finalParsed = new URL(finalUrl);
      storeSetCookies(finalParsed.hostname, upstream.headers);
      const contentType = (upstream.headers.get('content-type') || 'text/html; charset=utf-8').toLowerCase();
      const contentDisp = (upstream.headers.get('content-disposition') || '').toLowerCase();

      const isAttachment = contentDisp.includes('attachment');
      const isDownloadableBinary =
        isAttachment ||
        /application\/(zip|x-rar|x-7z|octet-stream|x-msdownload|vnd\.android\.package-archive|vnd\.openxmlformats|msword|pdf|x-tar|gzip)/i.test(
          contentType
        );

      if (isDownloadableBinary) {
        let suggestedName = '';
        const fnMatch = contentDisp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        if (fnMatch?.[1]) suggestedName = decodeURIComponent(fnMatch[1].trim());
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(
          `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Dosya İndiriliyor</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;background:#0f172a;color:#f8fafc">
  <h2 style="margin-bottom:8px">Dosya MY SYSTEM 18'e İndiriliyor...</h2>
  <p style="opacity:.75;font-size:14px">${finalUrl}</p>
  <button onclick="trigger()" style="margin-top:16px;padding:10px 20px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer">Tekrar İndir</button>
  <script>
    function trigger(){
      window.parent.postMessage({ type: 'my-browser-download', url: ${JSON.stringify(finalUrl)}, fileName: ${JSON.stringify(suggestedName)} }, '*');
    }
    trigger();
  </script>
</body></html>`
        );
      }

      if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
        let html = await upstream.text();
        // Neutralize CSP, X-Frame-Options, SRI hashes, crossorigin/nonce attributes, frame-busters, and rewrite meta refresh
        html = html.replace(/<meta[^>]+http-equiv=["']?(?:Content-Security-Policy|X-Frame-Options)["']?[^>]*>/gi, '');
        html = html.replace(/<meta[^>]+url=\/httpservice\/retry\/enablejs[^>]*>/gi, '');
        html = html.replace(
          /<meta([^>]+)http-equiv=["']?refresh["']?([^>]*)content=["']([^"']*url=)([^"']+)["']([^>]*)>/gi,
          (_, a, b, pre, u, c) => {
            try {
              const abs = new URL(u, finalUrl).href;
              return `<meta${a}http-equiv="refresh"${b}content="${pre}/api/proxy?url=${encodeURIComponent(abs)}"${c}>`;
            } catch {
              return _;
            }
          }
        );
        html = html.replace(/<base[^>]*>/gi, '');
        html = html.replace(/\sintegrity=["'][^"']*["']/gi, '');
        html = html.replace(/\scrossorigin(?:=["'][^"']*["'])?/gi, '');
        html = html.replace(/\snonce=["'][^"']*["']/gi, '');
        html = html.replace(/top\.location\s*=/gi, 'window.__blockedTop=');
        html = html.replace(/parent\.location\s*=/gi, 'window.__blockedParent=');
        html = html.replace(/window\.top\s*!==\s*window\.self|window\.self\s*!==\s*window\.top|self\s*!==\s*top|top\s*!==\s*self/gi, 'false');

        const baseTag = `<base href="${finalUrl.replace(/"/g, '&quot;')}">`;
        const bridgeScript = buildBrowserBridgeScript(finalUrl);

        if (/<head[^>]*>/i.test(html)) {
          html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}\n${bridgeScript}`);
        } else {
          html = `${baseTag}\n${bridgeScript}\n${html}`;
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      return res.send(buf);
    } catch {
      return res
        .status(502)
        .send(
          `<!doctype html><html lang="tr"><body style="font-family:system-ui,sans-serif;padding:32px;background:#0f172a;color:#e2e8f0"><h3>Site yüklenemedi</h3><p>${rawUrl} adresine şu an ulaşılamıyor veya bağlantı reddedildi.</p><button onclick="window.parent.postMessage({type:'my-browser-open-tab',url:${JSON.stringify(rawUrl)}},'*')" style="padding:8px 14px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer;margin-right:8px">Yeni Sekmede Tekrar Dene</button><button onclick="window.parent.postMessage({type:'my-browser-download',url:${JSON.stringify(rawUrl)}},'*')" style="padding:8px 14px;border-radius:8px;border:0;background:#059669;color:#fff;cursor:pointer">Dosya Olarak İndir</button></body></html>`
        );
    }
  });

  // Download Proxy for Browser -> VFS File Saving
  app.get('/api/download-proxy', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      return res.status(400).json({ error: 'Geçerli bir http/https adresi girin.' });
    }
    try {
      const upstream = await fetchWithTimeout(
        rawUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
          },
          redirect: 'follow',
        },
        12000
      );
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `Dosya indirilemedi (HTTP ${upstream.status}).` });
      }
      const mimeType = (upstream.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      const contentDisp = upstream.headers.get('content-disposition') || '';
      const dispMatch = contentDisp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
      const parsedUrl = new URL(upstream.url || rawUrl);
      const requestedName = String(req.query.fileName || '').trim();
      let fileName =
        (dispMatch?.[1] ? decodeURIComponent(dispMatch[1].trim()) : '') ||
        requestedName ||
        path.basename(parsedUrl.pathname) ||
        '';
      if (!fileName || !fileName.includes('.')) {
        const ext =
          mimeType.includes('html')
            ? 'html'
            : mimeType.includes('pdf')
              ? 'pdf'
              : mimeType.includes('zip')
                ? 'zip'
                : mimeType.includes('rar')
                  ? 'rar'
                  : mimeType.includes('7z')
                    ? '7z'
                    : mimeType.includes('android.package')
                      ? 'apk'
                      : mimeType.includes('msdownload')
                        ? 'exe'
                        : mimeType.includes('png')
                          ? 'png'
                          : mimeType.includes('jpeg')
                            ? 'jpg'
                            : mimeType.includes('webp')
                              ? 'webp'
                              : mimeType.includes('mpeg')
                                ? 'mp3'
                                : mimeType.includes('mp4')
                                  ? 'mp4'
                                  : mimeType.includes('json')
                                    ? 'json'
                                    : mimeType.startsWith('text/')
                                      ? 'txt'
                                      : 'bin';
        fileName = `${parsedUrl.hostname.replace(/^www\./, '')}_${Date.now().toString(36)}.${ext}`;
      }
      const arrayBuf = await upstream.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      // Cap at 8MB for IndexedDB safety
      if (buf.byteLength > 8 * 1024 * 1024) {
        return res.status(413).json({ error: 'Dosya boyutu 8 MB sınırını aşıyor.' });
      }
      const isText =
        mimeType.startsWith('text/') ||
        mimeType === 'application/json' ||
        mimeType === 'application/javascript' ||
        /\.(html|htm|txt|md|json|csv|js|css|svg|xml)$/i.test(fileName);

      const content = isText
        ? buf.toString('utf-8')
        : `data:${mimeType};base64,${buf.toString('base64')}`;

      return res.json({
        ok: true,
        fileName,
        mimeType,
        size: buf.byteLength,
        content,
      });
    } catch {
      return res.status(502).json({ error: 'İndirme bağlantısına ulaşılamadı.' });
    }
  });

  // Gemini 3 AI OS Command & Chat Endpoint (with strict timeout & clean fallback)
  app.post('/api/ai/command', async (req, res) => {
    const { prompt } = req.body as { prompt?: string };
    const clean = (prompt || '').trim();
    if (!clean) {
      return res.status(400).json({ error: 'Komut boş olamaz.' });
    }

    const state = readGlobalState();
    if (!state.aiConfig.enabled) {
      return res.status(400).json({ error: 'Gemini AI motoru Yönetici Ayarlarından devre dışı.' });
    }

    const ai = getGenAI();
    if (!ai) {
      return res.status(503).json({
        error: 'Gemini API anahtarı bulunamadı. Settings > Secrets panelinden ekleyin.',
      });
    }

    try {
      const modelName =
        state.aiConfig.model && !state.aiConfig.model.includes('hydrogen')
          ? state.aiConfig.model
          : DEFAULT_GEMINI_MODEL;

      const response = await Promise.race([
        ai.models.generateContent({
          model: modelName,
          contents: clean,
          config: {
            systemInstruction:
              state.aiConfig.systemInstruction +
              '\n\nKullanıcının isteğine göre JSON formatında yanıt dön. Eğer sistem işlemi gerekiyorsa `action` alanını doldur: ' +
              '"none" (sadece sohbet/bilgi), "set_theme" (value: "dark"|"light"|"custom"), ' +
              '"set_accent" (value: hex renk kodu), "open_app" (value: "file-manager"|"notepad"|"calculator"|"terminal"|"browser"|"chrome-browser"|"media-player"|"store"|"settings"|"converter"|"news"|"mertyusufdeniz"|"hdfilix"|"system-monitor"|"snake"|"minesweeper"|"game-2048"|"pomodoro"|"poki-web"|"my-paint"|"my-word"|"my-excel"|"my-powerpoint"|"ms-paint"|"ms-word"|"ms-excel"|"ms-powerpoint"), ' +
              '"create_folder" (value: klasör adı), "create_file" (value: dosya adı), ' +
              '"create_html_app" (value: tam HTML/CSS/JS kodu — kullanıcı özel uygulama, mini oyun veya araç istediğinde üret), ' +
              '"web_search" (value: arama sorgusu), "lock_screen", "check_updates", "mute_audio", "unmute_audio".',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                reply: { type: Type.STRING },
                action: { type: Type.STRING },
                value: { type: Type.STRING },
              },
              required: ['reply', 'action'],
            },
          },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 7500)),
      ]);

      const parsed = JSON.parse((response.text || '{}').trim()) as {
        reply?: string;
        action?: string;
        value?: string;
      };
      return res.json({
        ok: true,
        reply: parsed.reply || 'İşlem tamamlandı.',
        action: parsed.action || 'none',
        value: parsed.value || '',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini AI isteği başarısız oldu.';
      return res.status(503).json({ error: msg, fallback: true });
    }
  });

  // Real Chromium Live Engine status & close-tab endpoints
  const CHROMIUM_BIN = '/usr/bin/chromium';
  const CHROMIUM_PROFILE_DIR = path.join(DATA_DIR, 'chromium-profile');
  let chromiumContext: BrowserContext | null = null;
  let chromiumLaunchPromise: Promise<BrowserContext> | null = null;

  interface ChromiumTabSession {
    tabId: string;
    page: Page;
    cdp: CDPSession;
    width: number;
    height: number;
    clients: Set<WebSocket>;
    closeTimer?: ReturnType<typeof setTimeout>;
  }
  const chromiumTabs = new Map<string, ChromiumTabSession>();

  const getChromiumContext = async (): Promise<BrowserContext> => {
    if (chromiumContext) return chromiumContext;
    if (chromiumLaunchPromise) return chromiumLaunchPromise;

    chromiumLaunchPromise = (async () => {
      if (!fs.existsSync(CHROMIUM_PROFILE_DIR)) {
        fs.mkdirSync(CHROMIUM_PROFILE_DIR, { recursive: true });
      }
      const ctx = await playwrightChromium.launchPersistentContext(CHROMIUM_PROFILE_DIR, {
        executablePath: fs.existsSync(CHROMIUM_BIN) ? CHROMIUM_BIN : undefined,
        headless: true,
        locale: 'tr-TR',
        viewport: { width: 1200, height: 760 },
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--autoplay-policy=no-user-gesture-required',
        ],
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      chromiumContext = ctx;
      ctx.on('close', () => {
        chromiumContext = null;
        chromiumLaunchPromise = null;
        chromiumTabs.clear();
      });
      return ctx;
    })();

    try {
      return await chromiumLaunchPromise;
    } catch (err) {
      chromiumLaunchPromise = null;
      throw err;
    }
  };

  const broadcastTab = (session: ChromiumTabSession, payload: Record<string, unknown>) => {
    const raw = JSON.stringify(payload);
    session.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    });
  };

  const ensureChromiumTab = async (
    tabId: string,
    width: number,
    height: number,
    initialUrl?: string
  ): Promise<ChromiumTabSession> => {
    const existing = chromiumTabs.get(tabId);
    if (existing && !existing.page.isClosed()) {
      if (existing.closeTimer) {
        clearTimeout(existing.closeTimer);
        existing.closeTimer = undefined;
      }
      return existing;
    }

    const ctx = await getChromiumContext();
    const page = await ctx.newPage();
    const safeW = Math.max(480, Math.min(1920, Math.round(width || 1100)));
    const safeH = Math.max(360, Math.min(1200, Math.round(height || 700)));
    await page.setViewportSize({ width: safeW, height: safeH });

    const cdp = await ctx.newCDPSession(page);
    const session: ChromiumTabSession = {
      tabId,
      page,
      cdp,
      width: safeW,
      height: safeH,
      clients: new Set(),
    };
    chromiumTabs.set(tabId, session);

    cdp.on('Page.screencastFrame', async (evt: { data: string; sessionId: number }) => {
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId: evt.sessionId });
      } catch {
        // ignore ack errors if closing
      }
      let title = '';
      try {
        title = await page.title();
      } catch {
        // ignore
      }
      broadcastTab(session, {
        type: 'frame',
        data: evt.data,
        url: page.url(),
        title,
      });
    });

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: safeW,
      maxHeight: safeH,
      everyNthFrame: 1,
    });

    page.on('framenavigated', async (frame) => {
      if (frame === page.mainFrame()) {
        let title = '';
        try {
          title = await page.title();
        } catch {
          // ignore
        }
        broadcastTab(session, { type: 'nav', url: page.url(), title });
      }
    });

    page.on('load', async () => {
      let title = '';
      try {
        title = await page.title();
      } catch {
        // ignore
      }
      broadcastTab(session, { type: 'loaded', url: page.url(), title });
    });

    page.on('popup', async (popup) => {
      try {
        const popUrl = popup.url();
        if (popUrl && popUrl !== 'about:blank') {
          broadcastTab(session, { type: 'new-tab', url: popUrl });
        }
        await popup.close();
      } catch {
        // ignore
      }
    });

    page.on('download', async (download) => {
      try {
        const dlName = download.suggestedFilename() || `dosya_${Date.now()}.bin`;
        const tmpPath = await download.path();
        if (tmpPath && fs.existsSync(tmpPath)) {
          const buf = fs.readFileSync(tmpPath);
          if (buf.byteLength <= 8 * 1024 * 1024) {
            const ext = path.extname(dlName).toLowerCase();
            const isText = /\.(txt|md|html|htm|json|csv|svg|xml|js|css)$/i.test(ext);
            const mime = ext === '.pdf'
              ? 'application/pdf'
              : ext === '.docx'
                ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                : ext === '.xlsx'
                  ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                  : ext === '.png'
                    ? 'image/png'
                    : ext === '.jpg' || ext === '.jpeg'
                      ? 'image/jpeg'
                      : isText
                        ? 'text/plain'
                        : 'application/octet-stream';
            const content = isText
              ? buf.toString('utf-8')
              : `data:${mime};base64,${buf.toString('base64')}`;
            broadcastTab(session, {
              type: 'download',
              fileName: dlName,
              mimeType: mime,
              size: buf.byteLength,
              content,
            });
          }
        }
      } catch {
        // ignore download error
      }
    });

    if (initialUrl && /^https?:\/\//i.test(initialUrl)) {
      page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    }

    return session;
  };

  app.get('/api/chromium/status', (_req, res) => {
    const installed = fs.existsSync(CHROMIUM_BIN);
    return res.json({
      available: installed,
      binary: installed ? CHROMIUM_BIN : null,
      activeTabs: chromiumTabs.size,
    });
  });

  app.post('/api/chromium/close-tab', async (req, res) => {
    const { tabId } = req.body as { tabId?: string };
    if (tabId && chromiumTabs.has(tabId)) {
      const s = chromiumTabs.get(tabId)!;
      chromiumTabs.delete(tabId);
      try {
        await s.page.close();
      } catch {
        // ignore
      }
    }
    return res.json({ ok: true });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const reqUrl = req.url || '';
    if (!reqUrl.startsWith('/api/chromium-ws')) {
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    const urlObj = new URL(req.url || '/api/chromium-ws', `http://localhost:${PORT}`);
    const tabId = urlObj.searchParams.get('tabId') || 'tab_default';
    const w = Number(urlObj.searchParams.get('w')) || 1100;
    const h = Number(urlObj.searchParams.get('h')) || 700;
    const initialUrl = urlObj.searchParams.get('url') || undefined;

    let session: ChromiumTabSession;
    try {
      session = await ensureChromiumTab(tabId, w, h, initialUrl);
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: err instanceof Error ? err.message : 'Chromium başlatılamadı.',
        })
      );
      ws.close();
      return;
    }

    session.clients.add(ws);
    ws.send(
      JSON.stringify({
        type: 'ready',
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
      })
    );

    // Send immediate initial frame snapshot
    try {
      const shot = await session.page.screenshot({ type: 'jpeg', quality: 80 });
      ws.send(
        JSON.stringify({
          type: 'frame',
          data: shot.toString('base64'),
          url: session.page.url(),
          title: await session.page.title().catch(() => ''),
        })
      );
    } catch {
      // ignore
    }

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          url?: string;
          w?: number;
          h?: number;
          kind?: string;
          x?: number;
          y?: number;
          button?: 'left' | 'right' | 'middle';
          deltaX?: number;
          deltaY?: number;
          key?: string;
          text?: string;
        };

        const page = session.page;
        if (page.isClosed()) return;

        if (msg.type === 'navigate' && msg.url) {
          await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        } else if (msg.type === 'back') {
          await page.goBack().catch(() => {});
        } else if (msg.type === 'forward') {
          await page.goForward().catch(() => {});
        } else if (msg.type === 'reload') {
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        } else if (msg.type === 'resize' && msg.w && msg.h) {
          const nw = Math.max(480, Math.min(1920, Math.round(msg.w)));
          const nh = Math.max(360, Math.min(1200, Math.round(msg.h)));
          if (Math.abs(nw - session.width) > 12 || Math.abs(nh - session.height) > 12) {
            session.width = nw;
            session.height = nh;
            await page.setViewportSize({ width: nw, height: nh }).catch(() => {});
            await session.cdp
              .send('Page.startScreencast', {
                format: 'jpeg',
                quality: 80,
                maxWidth: nw,
                maxHeight: nh,
                everyNthFrame: 1,
              })
              .catch(() => {});
          }
        } else if (msg.type === 'mouse' && typeof msg.x === 'number' && typeof msg.y === 'number') {
          const btn = msg.button || 'left';
          if (msg.kind === 'move') {
            await page.mouse.move(msg.x, msg.y);
          } else if (msg.kind === 'down') {
            await page.mouse.move(msg.x, msg.y);
            await page.mouse.down({ button: btn });
          } else if (msg.kind === 'up') {
            await page.mouse.move(msg.x, msg.y);
            await page.mouse.up({ button: btn });
          } else if (msg.kind === 'dblclick') {
            await page.mouse.dblclick(msg.x, msg.y, { button: btn });
          }
        } else if (msg.type === 'wheel') {
          if (typeof msg.x === 'number' && typeof msg.y === 'number') {
            await page.mouse.move(msg.x, msg.y);
          }
          await page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
        } else if (msg.type === 'key' && msg.key) {
          if (msg.text && msg.text.length === 1 && /[^\x00-\x7F]/.test(msg.text)) {
            await page.keyboard.insertText(msg.text);
          } else if (msg.kind === 'down') {
            await page.keyboard.down(msg.key).catch(() => {
              if (msg.text) page.keyboard.insertText(msg.text).catch(() => {});
            });
          } else if (msg.kind === 'up') {
            await page.keyboard.up(msg.key).catch(() => {});
          } else {
            await page.keyboard.press(msg.key).catch(() => {});
          }
        } else if (msg.type === 'text' && msg.text) {
          await page.keyboard.insertText(msg.text);
        }
      } catch {
        // ignore transient ws message error
      }
    });

    ws.on('close', () => {
      session.clients.delete(ws);
      if (session.clients.size === 0) {
        session.closeTimer = setTimeout(async () => {
          if (session.clients.size === 0) {
            chromiumTabs.delete(session.tabId);
            try {
              await session.page.close();
            } catch {
              // ignore
            }
          }
        }, 45000);
      }
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`MY SYSTEM 18 Server + Real Chromium listening on http://localhost:${PORT}`);
  });
}

startServer();
