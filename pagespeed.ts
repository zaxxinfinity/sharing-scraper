/*
 * PageSpeed Insights Scraper
 * Author: ZynnShimaa!!
 * Base : https://pagespeed.web.dev/
 * Type : Scraper (Puppeteer)
 * Note : Jangan hapus watermark ini.
 */

import fs from "node:fs";

export type Strategy = "mobile" | "desktop";

export interface PageSpeedRun {
  strategy: Strategy;
  formFactor: string;
  fetchTime: string;
  requestedUrl: string;
  finalUrl: string;
  lighthouseVersion: string;
  runWarnings: string[];
  categories: Record<string, { title: string; score: number | null }>;
  metrics: Record<string, any>;
  issues: any[];
  audits?: any;
}

export interface PageSpeedResult {
  url: string;
  analysisId: string;
  analysisUrl: string;
  scrapedAt: string;
  runs: PageSpeedRun[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESULT_PATH = /^\/analysis\/[^/]+\/[^/]+/;

export function normalizeUrl(u: string): string {
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return new URL(u).href;
}

export function extractDataBlock(html: string): any {
  const re = /AF_initDataCallback\(\{key:\s*'ds:0'[\s\S]*?data:([\s\S]*?),\s*sideChannel:\s*\{\}\}\);\s*<\/script>/;
  const m = html.match(re);
  if (!m) throw new Error("Blok data hasil analisis tidak ditemukan.");
  return JSON.parse(m[1]);
}

export function extractLighthouseRuns(data: any): any[] {
  const runs = [];
  for (const row of data[4] || []) {
    const last = row[row.length - 1];
    if (typeof last === "string" && last.startsWith('{"fetchTime"')) runs.push(JSON.parse(last));
  }
  return runs;
}

export async function fetchAnalysisHtml(targetUrl: string, timeoutMs: number = 180000, verbose: boolean = false): Promise<{ html: string; analysisUrl: string }> {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    throw new Error("Modul 'puppeteer' belum terpasang. Jalankan: npm i puppeteer");
  }

  const log = (...m: any[]) => { if (verbose) console.error("[pagespeed]", ...m); };

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--lang=en-US",
      "--window-size=1366,900",
    ],
  });

  let page: any;
  
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    const ua = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const startUrl = `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(targetUrl)}`;
    log("membuka", startUrl);
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    log("menunggu analisis selesai (bisa 30-90 detik)...");
    const t0 = Date.now();
    let analysisUrl = null;
    
    while (Date.now() - t0 < timeoutMs) {
      const path = new URL(page.url()).pathname;
      if (RESULT_PATH.test(path)) {
        analysisUrl = page.url();
        break;
      }
      const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      if (/captcha|unusual traffic|not a robot/i.test(text)) {
        throw new Error("Diblokir captcha / deteksi bot");
      }
      await sleep(2000);
    }
    
    if (!analysisUrl) throw new Error(`Timeout ${timeoutMs / 1000} detik, halaman tidak pindah ke URL hasil`);
    log("hasil:", analysisUrl);

    let html = "";
    let runsFound = 0;
    let tries = 0;
    const t1 = Date.now();
    
    while (Date.now() - t1 < timeoutMs) {
      tries++;
      const resp = await page.goto(analysisUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      html = await resp.text();
      if (!/AF_initDataCallback\(\{key:\s*'ds:0'/.test(html)) html = await page.content();
      try {
        runsFound = extractLighthouseRuns(extractDataBlock(html)).length;
      } catch {
        runsFound = 0;
      }
      log(`percobaan ${tries}: ${runsFound} laporan Lighthouse ditemukan`);
      if (runsFound >= 2) break;
      await sleep(5000);
    }
    
    if (runsFound === 0) {
      throw new Error(`Analisis tidak selesai dalam ${timeoutMs / 1000} detik.`);
    }
    
    return { html, analysisUrl };
  } finally {
    await browser.close();
  }
}

export function summarize(lh: any, full: boolean = false): PageSpeedRun {
  const CORE_METRICS = [
    "first-contentful-paint",
    "largest-contentful-paint",
    "total-blocking-time",
    "cumulative-layout-shift",
    "speed-index",
    "interactive",
    "server-response-time",
  ];
  const SKIP_MODES = new Set(["notApplicable", "informative", "manual"]);

  const categories: Record<string, any> = {};
  for (const [id, c] of Object.entries(lh.categories || {})) {
    const cat = c as any;
    categories[id] = { title: cat.title, score: cat.score === null ? null : Math.round(cat.score * 100) };
  }

  const metrics: Record<string, any> = {};
  for (const id of CORE_METRICS) {
    const a = lh.audits[id];
    if (!a) continue;
    metrics[id] = {
      title: a.title,
      displayValue: a.displayValue ?? null,
      numericValue: a.numericValue ?? null,
      score: a.score,
    };
  }

  const issues = [];
  for (const [catId, cat] of Object.entries(lh.categories || {})) {
    const c = cat as any;
    for (const ref of c.auditRefs || []) {
      const a = lh.audits[ref.id];
      if (!a || a.score === null || SKIP_MODES.has(a.scoreDisplayMode) || a.score >= 0.9) continue;
      issues.push({
        category: catId,
        id: a.id,
        title: a.title,
        score: a.score,
        displayValue: a.displayValue ?? null,
        savingsMs: a.details?.overallSavingsMs ?? null,
        savingsBytes: a.details?.overallSavingsBytes ?? null,
        description: (a.description || "").replace(/\s*\[Learn more.*$/s, ""),
      });
    }
  }

  const run: PageSpeedRun = {
    strategy: (lh.configSettings?.formFactor === "desktop" ? "desktop" : "mobile") as Strategy,
    formFactor: lh.configSettings?.formFactor,
    fetchTime: lh.fetchTime,
    requestedUrl: lh.requestedUrl,
    finalUrl: lh.finalUrl,
    lighthouseVersion: lh.lighthouseVersion,
    runWarnings: lh.runWarnings,
    categories,
    metrics,
    issues,
  };
  if (full) run.audits = lh.audits;
  return run;
}

export async function runPageSpeed(targetUrl: string, strategies: Strategy[]): Promise<PageSpeedResult> {
  const url = normalizeUrl(targetUrl);
  const { html, analysisUrl } = await fetchAnalysisHtml(url);
  
  const data = extractDataBlock(html);
  const rawRuns = extractLighthouseRuns(data);
  if (!rawRuns.length) throw new Error("Data Lighthouse tidak ditemukan di hasil analisis.");

  let runs = rawRuns.map((r: any) => summarize(r, false));

  runs = runs.filter((r: PageSpeedRun) => strategies.includes(r.strategy));

  return {
    url: url,
    analysisId: data[0],
    analysisUrl: analysisUrl,
    scrapedAt: new Date().toISOString(),
    runs: runs,
  };
}
