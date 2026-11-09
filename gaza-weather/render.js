#!/usr/bin/env node
/*
 * يصدّر تصميم «طقس غزة» كصورة PNG.
 *
 *   node render.js           ← يستخدم البيانات المحفوظة في data.json
 *   node render.js --live    ← يجلب توقعات اليوم من Open-Meteo ويحدّث data.json أولاً
 *
 * الناتج: output/gaza-weather-YYYY-MM-DD.png (1080×1350، بدقة مضاعفة)
 */
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const SunCalc = require('suncalc');
const { chromium } = require('playwright');

const ROOT = __dirname;
const GAZA = { lat: 31.5017, lon: 34.4668, tz: 'Asia/Gaza' };
const GOOGLE_WEATHER_URL = 'https://www.google.com/search?q=' + encodeURIComponent('طقس غزة');

// النص كما نشرته موسوعة الأحاديث النبوية (HadeethEnc) — لا يُعدَّل حرفاً.
// https://hadeethenc.com/ar/browse/hadith/65527
const HADITH = {
  tag: 'حديث شريف',
  lead: 'عن عائشة أن رسول الله صلى الله عليه وسلم كان إذا رأى المطر قال:',
  quote: '«اللهم صَيِّبًا نافعًا».',
  ref: '<b>رواه البخاري</b> · درجة الحديث: صحيح',
};

const CONDITIONS = {
  clear: 'صحو',
  sunny: 'مشمس',
  partly: 'غائم جزئياً',
  cloudy: 'غائم',
  fog: 'ضباب',
  drizzle: 'رذاذ',
  rain: 'ماطر',
  snow: 'ثلوج',
  storm: 'عواصف رعدية',
};

// رموز الطقس العالمية (WMO) التي يعيدها Open-Meteo
function fromWmo(code) {
  if (code <= 1) return 'sunny';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

async function fetchLive() {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: GAZA.lat,
    longitude: GAZA.lon,
    current: 'relative_humidity_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: GAZA.tz,
    forecast_days: '7',
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = await res.json();
  return {
    source: 'Open-Meteo',
    updated: j.daily.time[0],
    today: { humidity: Math.round(j.current.relative_humidity_2m) },
    days: j.daily.time.map((date, i) => ({
      date,
      high: Math.round(j.daily.temperature_2m_max[i]),
      low: Math.round(j.daily.temperature_2m_min[i]),
      condition: fromWmo(j.daily.weather_code[i]),
      precip: j.daily.precipitation_probability_max[i] ?? 0,
    })),
  };
}

/* ---------- formatting ---------- */
const AR = 'ar-u-nu-arab';
const num = (n) => Number(n).toLocaleString(AR);
const noon = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 10)); // 12:00 بتوقيت غزة
};
const fmt = (date, opts) => new Intl.DateTimeFormat(AR, { timeZone: GAZA.tz, ...opts }).format(date);
const fmtTime = (date) => fmt(date, { hour: 'numeric', minute: '2-digit' });
const hijri = (date) =>
  new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', {
    timeZone: GAZA.tz, day: 'numeric', month: 'long', year: 'numeric',
  }).format(date);

function buildView(data, qrSvg) {
  const days = data.days.slice(0, 7);
  const today = days[0];
  const d0 = noon(today.date);
  const sun = SunCalc.getTimes(d0, GAZA.lat, GAZA.lon);
  const precip = today.precip ?? 0;

  const lows = days.map((d) => d.low);
  const highs = days.map((d) => d.high);
  const first = noon(days[0].date);
  const last = noon(days[days.length - 1].date);
  const sameMonth = first.getUTCMonth() === last.getUTCMonth();

  return {
    place: 'قطاع غزة · فلسطين',
    dayName: fmt(d0, { weekday: 'long' }),
    gregorian: fmt(d0, { day: 'numeric', month: 'long', year: 'numeric' }),
    hijri: hijri(d0),
    hero: {
      chip: `طقس اليوم · ${CONDITIONS[today.condition]}`,
      key: today.condition,
      label: today.condition === 'clear' ? 'صحوٌ ومشمس' : CONDITIONS[today.condition],
      high: num(today.high),
      low: num(today.low),
    },
    stats: [
      { icon: 'humidity', k: 'الرطوبة', v: data.today?.humidity != null ? `${num(data.today.humidity)}٪` : '—' },
      { icon: 'rain', k: 'فرصة المطر', v: `${num(precip)}٪` },
      { icon: 'sunrise', k: 'الشروق', v: fmtTime(sun.sunrise) },
      { icon: 'sunset', k: 'الغروب', v: fmtTime(sun.sunset) },
    ],
    span: sameMonth
      ? `${num(first.getUTCDate())} – ${fmt(last, { day: 'numeric', month: 'long' })}`
      : `${fmt(first, { day: 'numeric', month: 'long' })} – ${fmt(last, { day: 'numeric', month: 'long' })}`,
    weekMin: Math.min(...lows),
    weekMax: Math.max(...highs),
    week: days.map((d, i) => ({
      name: i === 0 ? 'اليوم' : fmt(noon(d.date), { weekday: 'long' }),
      date: fmt(noon(d.date), { day: 'numeric', month: 'long' }),
      key: d.condition,
      high: num(d.high),
      low: num(d.low),
      highN: d.high,
      lowN: d.low,
    })),
    hadith: HADITH,
    qr: qrSvg,
    src: `المصدر: <b>${data.source}</b><br>آخر تحديث: ${fmt(noon(data.updated), { day: 'numeric', month: 'long', year: 'numeric' })}`,
  };
}

/* ---------- fonts: inline the Arabic + Latin subsets as data URIs ---------- */
function fontCss() {
  const sets = [
    ['cairo', [400, 600, 700, 800]],
    ['amiri', [400, 700]],
    ['reem-kufi', [600, 700]],
  ];
  let css = '';
  for (const [pkg, weights] of sets) {
    const dir = path.join(ROOT, 'node_modules', '@fontsource', pkg);
    for (const w of weights) {
      const src = fs.readFileSync(path.join(dir, `${w}.css`), 'utf8');
      for (const block of src.split('@font-face').slice(1)) {
        const file = block.match(/url\(\.\/files\/([^)]+\.woff2)\)/);
        if (!file || !/-(arabic|latin)-\d/.test(file[1])) continue;
        const b64 = fs.readFileSync(path.join(dir, 'files', file[1])).toString('base64');
        css += '@font-face' + block
          .replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${b64}) format('woff2');`)
          .replace(/font-display:\s*swap;/, 'font-display: block;')
          .replace(/\/\*[^*]*\*\//g, '');
      }
    }
  }
  return css;
}

async function main() {
  let data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  if (process.argv.includes('--live')) {
    try {
      data = await fetchLive();
      fs.writeFileSync(path.join(ROOT, 'data.json'), JSON.stringify(data, null, 2) + '\n');
      console.log('✓ تم جلب أحدث توقعات من Open-Meteo');
    } catch (err) {
      console.warn(`! تعذّر الجلب المباشر (${err.message})، سيتم استخدام data.json`);
    }
  }

  const qrSvg = await QRCode.toString(GOOGLE_WEATHER_URL, {
    type: 'svg', margin: 0, errorCorrectionLevel: 'M',
    color: { dark: '#061A31', light: '#FFFFFF' },
  });

  const view = buildView(data, qrSvg);
  const html = fs.readFileSync(path.join(ROOT, 'template.html'), 'utf8')
    .replace('/*FONTS*/', fontCss())
    .replace('/*VIEW*/', `window.VIEW = ${JSON.stringify(view)};`);

  const buildDir = path.join(ROOT, 'build');
  const outDir = path.join(ROOT, 'output');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(buildDir, 'gaza-weather.html');
  fs.writeFileSync(htmlPath, html);

  const scale = Number(process.env.SCALE || 2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: scale });
  await page.goto('file://' + htmlPath);
  await page.waitForSelector('body[data-ready="1"]');
  const out = path.join(outDir, `gaza-weather-${data.days[0].date}.png`);
  await page.locator('#poster').screenshot({ path: out });
  await browser.close();
  console.log('✓ ' + path.relative(process.cwd(), out));
}

main().catch((err) => { console.error(err); process.exit(1); });
