/*
 * Subdomain Finder Scraper
 * Author: ZynnShimaa!!
 * Base : https://subdomainfinder.c99.nl/
 * Type : Scraper - TypeScript
 * Note : Jangan hapus watermark ini.
 * 
 * Cara Penggunaan (Jalankan dari root project):
 * 1. Buka scan hari ini: npx tsx subdomain.ts domain.com
 * 2. Buka scan tanggal tertentu: npx tsx subdomain.ts domain.com --date 2026-10-20
 * 3. Langsung pakai URL: npx tsx subdomain.ts https://subdomainfinder.c99.nl/scans/2026-11-02/domain.com
 * 4. Parse file HTML lokal: npx tsx subdomain.ts --file hasil.html
 */

import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const FILE = opt("--file");
const OUT = opt("--out");
const DATE = opt("--date");
const SAVE = opt("--save");
const input = args.filter((a, i) => !a.startsWith("--") && !["--file", "--out", "--date", "--save"].includes(args[i - 1]))[0];

const BASE = "https://subdomainfinder.c99.nl";

const text = (h: string) =>
  h
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function buildScanUrl(inp: string): string {
  if (/^https?:\/\//i.test(inp)) {
    const u = new URL(inp);
    if (u.hostname === "subdomainfinder.c99.nl") return u.href;
    inp = u.hostname;
  }
  const domain = inp.replace(/\/.*$/, "").toLowerCase();
  const date = DATE || new Date().toISOString().slice(0, 10);
  return `${BASE}/scans/${date}/${domain}`;
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; subdomain-reader/1.0)", Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} saat membuka ${url}`);
  return res.text();
}

interface SubdomainData {
  subdomain: string | null;
  ip: string | null;
  cloudflare: boolean;
}

interface IpCount {
  ip: string;
  count: number;
}

interface ScanHistory {
  date: string;
  url: string;
}

function parse(html: string, scanUrl: string | null) {
  const domain = html.match(/<h4>Result of ([^<]+)<\/h4>/)?.[1]?.trim();
  if (!domain) {
    throw new Error(
      "Halaman hasil scan tidak ditemukan. Scan untuk domain/tanggal itu mungkin belum ada, atau halaman diblokir. " +
        "Jalankan scan sekali lewat browser, lalu pakai URL scan-nya atau --file."
    );
  }

  const field = (label: string): string | null => {
    const m = html.match(new RegExp(`<td><b>${label}</b></td>\\s*<td>([\\s\\S]*?)</td>`));
    return m ? text(m[1]) : null;
  };

  const country = field("Domain Country:");
  const cm = country?.match(/^(.*?)\s*\(([A-Z]{2})\)$/);
  const most = field("Most used IP:")?.match(/^(\S+)\s*\((\d+)x\)/);
  const found = field("Subdomains found:");

  const cls = (name: string) => new RegExp(`class=['"][^'"]*\\b${name}\\b[^'"]*['"][^>]*>\\s*([^<\\s][^<]*?)\\s*<`);
  const subdomains: SubdomainData[] = html
    .split(/<tr\b/i)
    .filter((chunk) => /class=['"][^'"]*\bsd\b[^'"]*['"]/.test(chunk))
    .map((row) => ({
      subdomain: row.match(cls("sd"))?.[1] ?? null,
      ip: row.match(cls("ip"))?.[1] ?? null,
      cloudflare: /data-cf=['"]true['"]/.test(row),
    }))
    .filter((r) => r.subdomain);

  const ipCounts: IpCount[] = [
    ...html.matchAll(
      /<tr>\s*<td>\s*<a[^>]*href=['"][^'"]*\/geoip\/[^'"]+['"][^>]*>([^<]+)<\/a>\s*<\/td>\s*<td>\s*(\d+)\s*<\/td>\s*<\/tr>/g
    ),
  ].map((m) => ({ ip: m[1].trim(), count: Number(m[2]) }));

  const seen = new Set<string>();
  const scanHistory: ScanHistory[] = [];
  for (const m of html.matchAll(/<a href="\/\/subdomainfinder\.c99\.nl\/scans\/(\d{4}-\d{2}-\d{2})\/([^"]+)">/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    scanHistory.push({ date: m[1], url: `${BASE}/scans/${m[1]}/${m[2]}` });
  }

  const warnings: string[] = [];
  if (found && Number(found) > subdomains.length) warnings.push(`Header menyebut ${found} subdomain, tetapi hanya ${subdomains.length} yang terbaca dari HTML. Simpan HTML dengan --save raw.html untuk diperiksa.`);
  if (most && !ipCounts.length) warnings.push("Tabel hitungan IP tidak terbaca dari HTML.");

  return {
    ...(warnings.length ? { warnings } : {}),
    domain,
    scanUrl: scanUrl || html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || null,
    scanDate: field("Scan date"),
    country: cm ? { name: cm[1], code: cm[2] } : country,
    subdomainsFound: found ? Number(found) : subdomains.length,
    mostUsedIp: most ? { ip: most[1], count: Number(most[2]) } : null,
    subdomains,
    ipCounts,
    scanHistory,
  };
}

async function main() {
  let html: string, scanUrl: string | null = null;
  if (FILE) {
    html = fs.readFileSync(FILE, "utf8");
  } else {
    if (!input) {
      console.error("Pemakaian: npx tsx subdomain.ts <domain|url-scan> [--date YYYY-MM-DD] [--out file.json] | --file hasil.html");
      process.exit(1);
    }
    scanUrl = buildScanUrl(input);
    html = await fetchPage(scanUrl);
    if (SAVE) fs.writeFileSync(SAVE, html);
  }

  const json = JSON.stringify(parse(html, scanUrl), null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  process.stdout.write(json + "\n");
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
