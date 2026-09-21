/* export_unified.js
 * 只读抽取红猫/品专/闪购现有看板产物 -> D:/桌面/看板中心/data/*.js (共享数据层)
 * 不改动任何现有看板文件与每日流程；中心壳 index.html 通过 <script src> 加载这些 .js。
 * 运行： node export_unified.js
 */
const fs = require('fs');
const vm = require('vm');
const HOME = 'C:/Users/李一诺/WorkBuddy';
const OUT = 'C:/Users/李一诺/WorkBuddy/2026-09-16-10-21-18/dashboard_deploy';
const DATA = OUT + '/data';
const ASSETS = OUT + '/assets';

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
ensureDir(DATA); ensureDir(ASSETS);

// ---- 通用：从源码中抽取 const VAR = {...}; (平衡括号) ----
function extractObject(src, name) {
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*');
  const m = re.exec(src);
  if (!m) throw new Error('not found ' + name);
  let i = m.index + m[0].length, depth = 0, start = i, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { if (ch === inStr && src[i - 1] !== '\\') inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const r2 = n => Math.round(n * 100) / 100;
const intfmt = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function stripTags(s) { return String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(); }
function parsePct(s) { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }

// ---- 闪购素材源目录 ----
// 注意：管线现在把素材产出到「根 images/、videos/」，旧的 dist/images、dist/videos 已停更，
// 且两边文件名集合并不一致（旧 dist 缺 7 张图、视频名与图号错位）。优先用根目录，空了才回退 dist。
const SG_ROOT = HOME + '/2026-09-09-09-59-47';
function pickDir(primary, fallback) {
  try { if (fs.existsSync(primary) && fs.readdirSync(primary).length) return primary; } catch (e) {}
  return fallback;
}
const SG_IMG_DIR = pickDir(SG_ROOT + '/images', SG_ROOT + '/dist/images');
const SG_VID_DIR = pickDir(SG_ROOT + '/videos', SG_ROOT + '/dist/videos');

// =================== 1. 红猫 (MODELS) ===================
function buildHongmao() {
  const hm = fs.readFileSync(HOME + '/2026-08-20-16-26-41/投放看板_联世_火奴.html', 'utf8');
  const MODELS = vm.runInNewContext('(' + extractObject(hm, 'MODELS') + ')', {});
  const CAT_NAMES = { nb: '笔记本', phone: '手机', tablet: '平板' };

  function dailyFromAgg(da) {
    return Object.keys(da || {}).sort().map(d => {
      const t = (da[d] && da[d].t) || {};
      const o = { date: d };
      for (const f in t) o[f] = t[f];
      o.roi = t.spend > 0 ? r2(t.gmv / t.spend) : 0;
      return o;
    });
  }
  function sumDaily(arr) {
    const s = { spend: 0, gmv: 0, imp: 0, clk: 0, fav: 0, cart: 0, visit: 0, interact: 0, video_play: 0, orders: 0, refund_orders: 0, refund_amount: 0 };
    arr.forEach(x => { for (const f in s) s[f] += (x[f] || 0); });
    s.roi = s.spend > 0 ? r2(s.gmv / s.spend) : 0;
    return s;
  }

  const periods = {};
  const catMap = {};
  for (const k in MODELS) {
    const mo = MODELS[k];
    const daily = dailyFromAgg(mo.dailyAgg);
    const summary = sumDaily(daily);
    const cat = (k.split('_')[0]) || 'other';
    periods[k] = Object.assign({}, mo, { key: k, cat, daily, summary });
    if (CAT_NAMES[cat]) (catMap[cat] = catMap[cat] || []).push(k);
  }

  const sumAgg = {}, sumMaterials = [], sumPlanRows = [], sumCreRows = [], sumProduct = [];
  const posMap = {}, catMap2 = {};
  for (const k in MODELS) {
    const mo = MODELS[k];
    for (const d in (mo.dailyAgg || {})) {
      const t = (mo.dailyAgg[d] && mo.dailyAgg[d].t) || {};
      const o = sumAgg[d] || (sumAgg[d] = {});
      for (const f in t) o[f] = (o[f] || 0) + (t[f] || 0);
    }
    (mo.materials || []).forEach(m => sumMaterials.push(m));
    (mo.planRows || []).forEach(r => sumPlanRows.push(r));
    (mo.creRows || []).forEach(r => sumCreRows.push(r));
    (mo.productAnalysis || []).forEach(r => sumProduct.push(r));
    (mo.posSummary && mo.posSummary.rows || []).forEach(r => {
      const o = posMap[r.pos] || (posMap[r.pos] = { pos: r.pos, goal: r.goal, spend: 0, gmv: 0, visit: 0 });
      o.spend += r.spend || 0; o.gmv += r.gmv || 0; o.visit += r.visit || 0;
    });
    (mo.categoryAgg || []).forEach(r => {
      const o = catMap2[r.cat] || (catMap2[r.cat] = { cat: r.cat, orders: 0, gmv: 0, refund_orders: 0, refund_amount: 0 });
      o.orders += r.orders || 0; o.gmv += r.gmv || 0; o.refund_orders += r.refund_orders || 0; o.refund_amount += r.refund_amount || 0;
    });
  }
  const sumDailyArr = Object.keys(sumAgg).sort().map(d => {
    const o = { date: d }; for (const f in sumAgg[d]) o[f] = sumAgg[d][f];
    o.roi = sumAgg[d].spend > 0 ? r2(sumAgg[d].gmv / sumAgg[d].spend) : 0; return o;
  });
  const sumSummary = sumDaily(sumDailyArr);
  const sumPos = Object.values(posMap).map(o => ({
    pos: o.pos, goal: o.goal, spend: Math.round(o.spend), gmv: Math.round(o.gmv),
    roi: o.spend > 0 ? r2(o.gmv / o.spend) : 0, visit: Math.round(o.visit),
    visit_cost: o.visit > 0 ? r2(o.spend / o.visit) : 0
  }));
  const sumCat = Object.values(catMap2).map(o => ({
    cat: o.cat, orders: o.orders, gmv: Math.round(o.gmv), refund_orders: o.refund_orders,
    refund_amount: Math.round(o.refund_amount),
    refund_rate: o.orders > 0 ? r2(o.refund_orders / o.orders * 100) : 0,
    amt_refund_rate: o.gmv > 0 ? r2(o.refund_amount / o.gmv * 100) : 0
  }));
  const sumKpis = [
    { label: '总花费', value: '¥' + intfmt(sumSummary.spend), sub: '店铺成交口径(15日归因)', cls: 'primary' },
    { label: '店铺成交GMV', value: '¥' + intfmt(sumSummary.gmv), sub: '15日归因', cls: 'primary' },
    { label: '成交ROI', value: String(sumSummary.roi), sub: 'GMV / 花费', cls: 'good' },
    { label: '成交笔数', value: String(sumSummary.orders), sub: '退款 ' + sumSummary.refund_orders + ' 单', cls: 'good' },
    { label: '退款率', value: (sumSummary.orders > 0 ? r2(sumSummary.refund_orders / sumSummary.orders * 100) : 0) + '%', sub: '退款 ' + sumSummary.refund_orders + ' 单 / ¥' + intfmt(sumSummary.refund_amount), cls: 'warn' }
  ];
  periods['sum'] = {
    key: 'sum', cat: 'all', label: '汇总', daily: sumDailyArr, summary: sumSummary,
    materials: sumMaterials, planRows: sumPlanRows, creRows: sumCreRows,
    productAnalysis: sumProduct, posSummary: { rows: sumPos }, categoryAgg: sumCat, kpis: sumKpis,
    planCols: (MODELS[Object.keys(MODELS)[0]] || {}).planCols || null,
    creCols: (MODELS[Object.keys(MODELS)[0]] || {}).creCols || null
  };

  const cats = [
    { key: 'nb', name: '笔记本', periods: catMap.nb || [] },
    { key: 'phone', name: '手机', periods: catMap.phone || [] },
    { key: 'tablet', name: '平板', periods: catMap.tablet || [] },
    { key: 'sum', name: '汇总', periods: ['sum'] }
  ].filter(c => c.periods.length);

  const dayMap = {};
  sumDailyArr.forEach(x => {
    const o = dayMap[x.date] || (dayMap[x.date] = { date: x.date, spend: 0, gmv: 0, imp: 0, clk: 0 });
    o.spend += x.spend; o.gmv += x.gmv; o.imp += x.imp; o.clk += x.clk;
  });
  const daily = Object.keys(dayMap).sort().map(d => {
    const o = dayMap[d];
    return { date: d, spend: Math.round(o.spend), gmv: Math.round(o.gmv), imp: Math.round(o.imp), clk: Math.round(o.clk), roi: o.spend > 0 ? r2(o.gmv / o.spend) : 0 };
  });
  const tot = { spend: 0, gmv: 0, imp: 0, clk: 0 };
  daily.forEach(x => { tot.spend += x.spend; tot.gmv += x.gmv; tot.imp += x.imp; tot.clk += x.clk; });
  const models = Object.keys(periods).filter(k => k !== 'sum').map(k => {
    const p = periods[k];
    return { key: k, label: p.label, spend: p.summary.spend, gmv: p.summary.gmv, imp: p.summary.imp, clk: p.summary.clk, roi: p.summary.roi };
  });
  return {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: '投放看板_联世_火奴.html (MODELS)',
    totals: { spend: Math.round(tot.spend), gmv: Math.round(tot.gmv), imp: Math.round(tot.imp), clk: Math.round(tot.clk), roi: tot.spend > 0 ? r2(tot.gmv / tot.spend) : 0 },
    daily, cats, periods, models
  };
}

// =================== 2. 品专 (CSV + HTML 年度对比 + 创意明细 + 业务事件) ===================
function buildPinzuan() {
  const csv = fs.readFileSync(HOME + '/2026-08-07-10-12-57/品牌专区_点击率日追踪.csv', 'utf8');
  const lines = csv.split(/\r?\n/).filter(l => l.trim() !== '');
  const header = lines.shift().split(',');
  const cols = { date: 0, imp: 1, clk: 2, ctr: 3, month: 4, target: 5, gap: 6, status: 7, src: 8 };
  const records = lines.map(l => {
    const p = l.split(',');
    return {
      date: p[cols.date], imp: +p[cols.imp], clk: +p[cols.clk], ctr: +p[cols.ctr],
      month: +p[cols.month], target: +p[cols.target], gap: +p[cols.gap], status: p[cols.status], src: p[cols.src]
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const latest = records[records.length - 1];
  let sumImp = 0, sumClk = 0; records.forEach(r => { sumImp += r.imp; sumClk += r.clk; });
  const avgCtr = sumImp ? r2(sumClk / sumImp * 100) : 0;
  const byMonth = {};
  records.forEach(r => { const m = byMonth[r.month] || (byMonth[r.month] = { month: r.month, imp: 0, clk: 0, ctr: 0, target: r.target }); m.imp += r.imp; m.clk += r.clk; });
  const months = Object.values(byMonth).map(m => ({ month: m.month, ctr: m.imp ? r2(m.clk / m.imp * 100) : 0, target: m.target, imp: m.imp, clk: m.clk }));

  // 年度同比对比（2025 实际 vs 2026 实际/目标），从原 HTML 内联表解析
  const html = fs.readFileSync(HOME + '/2026-08-07-10-12-57/品牌专区_点击率日追踪.html', 'utf8');
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  const aTbl = tables.find(t => t.indexOf('2025实际') >= 0);
  const annual = [];
  if (aTbl) {
    const re = /<tr[^>]*>([\s\S]*?)<\/tr>/g; let m;
    while ((m = re.exec(aTbl))) {
      const cells = m[1].split(/<\/td>/i).map(c => stripTags(c.replace(/<td[^>]*>/i, ''))).filter(c => c !== '');
      if (cells.length >= 4 && /月$/.test(cells[0])) {
        annual.push({
          month: cells[0],
          y2025: parsePct(cells[1]),
          y2026: parsePct(cells[2]),
          y2026IsTarget: cells[2].indexOf('目标') >= 0,
          gap: parsePct(cells[3]),
          status: (cells[4] || '').replace(/[（(].*$/, '').trim()
        });
      }
    }
  }

  // 创意明细（最新一天），从 CSV 解析
  const creLines = fs.readFileSync(HOME + '/2026-08-07-10-12-57/品牌专区_创意明细.csv', 'utf8').split(/\r?\n/).filter(l => l.trim() !== '');
  creLines.shift(); // header
  const creatives = creLines.map(l => {
    const p = l.split(',');
    return { id: p[0], name: p[1], imp: +p[2], clk: +p[3], ctr: +p[4] };
  }).filter(c => c.id);
  const creMaxImp = Math.max.apply(null, creatives.map(c => c.imp).concat([1]));
  creatives.forEach(c => { c.share = c.imp / creMaxImp * 100; });

  // 业务事件记录，从 CSV 解析
  const evLines = fs.readFileSync(HOME + '/2026-08-07-10-12-57/品牌专区_业务事件.csv', 'utf8').split(/\r?\n/).filter(l => l.trim() !== '');
  evLines.shift();
  const events = evLines.map(l => { const p = l.split(','); return { date: p[0], event: p[1] }; });

  // 事件当日点击率（从 records 匹配）
  events.forEach(e => {
    const rec = records.find(r => r.date === e.date);
    e.ctr = rec ? rec.ctr : null;
    e.status = rec ? rec.status : null;
  });

  // 与原看板卡片对齐的衍生指标
  const extractCard = (label) => {
    const re = new RegExp(label + '[\\s\\S]*?<div class=["\']card-val["\']>([\\d.]+)%');
    const m = html.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  // 2026 已发生月份（1-7 月）加权 CTR，作为卡片回退
  let y2026OccurredImp = 0, y2026OccurredClk = 0;
  records.forEach(r => { if (r.month <= 7) { y2026OccurredImp += r.imp; y2026OccurredClk += r.clk; } });
  const y2026OccurredFallback = y2026OccurredImp ? r2(y2026OccurredClk / y2026OccurredImp * 100) : 0;
  // 下半年目标（同比+1% / 下半年加权需达）
  const y2025Avg = extractCard('2025全年点击率') || (annual.length ? r2(annual.reduce((a, b) => a + b.y2025, 0) / annual.length) : 0);
  const h2Target = extractCard('下半年需达') || 40.08;
  const y2026Occurred = extractCard('2026已发生') || y2026OccurredFallback;

  return {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: '品牌专区_点击率日追踪.csv + 年度对比 + 创意明细 + 业务事件',
    latest, avgCtr, sumImp, sumClk,
    y2025Avg, y2026Occurred, h2Target,
    records, months, annual, creatives, events
  };
}

// =================== 3. 闪购 (dashboard_data.json 全量) ===================
function buildShangou() {
  const d = JSON.parse(fs.readFileSync(OUT + '/dashboard_data_new.json', 'utf8'));
  const meta = d.meta || {};
  const overall = d.overall || {};
  const daily = (d.daily || []).map(x => ({
    date: '2026-' + x.日期, dateShort: x.日期,
    ctr: x.点击率, ctr_dk: x.单坑_点击率, ctr_sk: x.双坑_点击率,
    imp: x.曝光量, clk: x.点击量
  }));
  const byKeng = (d.by_keng || []).map(x => ({ name: x.name, ctr: x.点击率, uvCtr: x.UV点击率, reach: x.到达率, jump: x.二跳率, interest: x.消费者兴趣人数, imp: x.曝光量, clk: x.点击量 }));

  // 素材画廊：图片/视频按「创意名」匹配产物目录里的素材文件。
  // ⚠ 源数据的 _img 字段实测恒为 null（管线未回填），不能依赖它——否则整柜素材显示「无图」。
  // 素材文件名形如 NN_4_闪购<创意名>.jpg / NN_v_闪购<创意名>.mp4；NN 序号每次重跑都会变，故只按去掉前缀的名字匹配。
  const SG_ASSET = 'assets/shangou/';
  const imgByName = {}, imgByNameCI = {}, vidByName = {}, vidByNameCI = {};
  try {
    fs.readdirSync(OUT + '/assets/shangou').forEach(f => {
      let m = f.match(/^\d+_4_(闪购.+)\.(?:jpe?g|png|webp)$/i);
      if (m) { const k = m[1], lk = k.toLowerCase(); if (!imgByName[k]) imgByName[k] = f; if (!imgByNameCI[lk]) imgByNameCI[lk] = f; return; }
      m = f.match(/^\d+_v_(闪购.+)\.mp4$/i);
      if (m) { const k = m[1], lk = k.toLowerCase(); if (!vidByName[k]) vidByName[k] = f; if (!vidByNameCI[lk]) vidByNameCI[lk] = f; }
    });
  } catch (e) {}

  // 创意名自带结构化信息：闪购<坑位>_<品类码>_<产品>。
  // 源数据的 坑位/品类/产品 三列常为空，导致画廊筛选与徽标失效——这里从名字解析补齐（有值则优先用原值）。
  const PIN_TEXT = { NB: '笔记本NB', PAD: '平板PAD', 选件: '选件' };
  function parseCreativeName(n) {
    const s = String(n || '');
    const seg = s.split('_');
    const keng = s.indexOf('双坑') >= 0 ? '双坑' : (s.indexOf('单坑') >= 0 ? '单坑' : '');
    const code = seg.length > 1 ? seg[1] : '';
    return { keng: keng, pin: PIN_TEXT[code] || code, product: seg.length > 2 ? seg.slice(2).join('_') : '' };
  }
  const byCreative = (d.by_creative || []).map(x => {
    const nm = String(x.name || ''), lk = nm.toLowerCase();
    const imgFile = imgByName[nm] || imgByNameCI[lk] || '';
    const vidFile = vidByName[nm] || vidByNameCI[lk] || '';
    const pn = parseCreativeName(nm);
    return {
      name: x.name, imp: x.曝光量, clk: x.点击量, ctr: x.点击率, uvCtr: x.UV点击率,
      reach: x.到达率, jump: x.二跳率, brandSearch: x.品牌回搜率_uv, brandReturn: x.品牌回访率_uv,
      interest: x.消费者兴趣人数,
      keng: x.坑位 || pn.keng, pin: x.品类 || pn.pin, product: x.产品 || pn.product,
      type: x.创意类型, link: x.素材地址, img: imgFile ? SG_ASSET + imgFile : '', video: vidFile ? SG_ASSET + vidFile : ''
    };
  });
  {
    const nImg = byCreative.filter(c => c.img).length, nVid = byCreative.filter(c => c.video).length;
    console.log('  素材匹配：img ' + nImg + '/' + byCreative.length + ' · video ' + nVid + '/' + byCreative.length);
  }
  const byPin = (d.by_pin || []).map(x => ({ name: x.name, imp: x.曝光量, clk: x.点击量, ctr: x.点击率, interest: x.消费者兴趣人数 }));
  const byPlan = (d.by_plan || []).map(x => ({ name: x.name, imp: x.曝光量, clk: x.点击量, ctr: x.点击率 }));
  const byUnit = (d.by_unit || []).map(x => ({ name: x.name, imp: x.曝光量, clk: x.点击量, ctr: x.点击率 }));
  const byAudience = (d.by_audience || []).map(x => ({ name: x.name, imp: x.曝光量, clk: x.点击量, ctr: x.点击率, interest: x.消费者兴趣人数 }));
  const opt = d.optimization || {};
  const lowCtr = (opt.low_ctr || []).map(x => {
    const pn = parseCreativeName(x.name);
    return {
      name: x.name, keng: x.坑位 || pn.keng, pin: x.品类 || pn.pin, product: x.产品 || pn.product,
      imp: x.曝光量, clk: x.点击量, ctr: x.点击率, link: x.素材地址,
      extraAvg: x.extra_to_avg, extraBench: x.extra_to_bench
    };
  });

  return {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'dashboard_data.json (万相台订单结案报表)',
    meta, overall, daily, byKeng, byCreative, byPin, byPlan, byUnit, byAudience,
    optimization: {
      lowCtr, overall_ctr: opt.overall_ctr, benchmark_ctr: opt.benchmark_ctr,
      total_extra_to_avg: opt.total_extra_to_avg, total_extra_to_bench: opt.total_extra_to_bench,
      new_ctr_to_avg: opt.new_ctr_to_avg, new_ctr_to_bench: opt.new_ctr_to_bench, n_low: opt.n_low
    },
    dates: d.dates || []
  };
}

// =================== 写出 ===================
function writeJS(name, obj) {
  const body = 'window.DASH = window.DASH || {};\nwindow.DASH.' + name + ' = ' + JSON.stringify(obj, null, 2) + ';\n';
  fs.writeFileSync(DATA + '/' + name + '.js', body);
  fs.writeFileSync(DATA + '/' + name + '.json', JSON.stringify(obj, null, 2));
}

const hm = buildHongmao();
const pz = buildPinzuan();
const sg = buildShangou();
writeJS('hongmao', hm);
writeJS('pinzuan', pz);
writeJS('shangou', sg);

// 复制 Chart.js 到本地 assets（保证 file:// 离线可用）
const hmHtml = fs.readFileSync(HOME + '/2026-08-20-16-26-41/投放看板_联世_火奴.html', 'utf8');
const cs = hmHtml.indexOf('!function(t,e){"object"==typeof exports');
const ce = hmHtml.indexOf('</script>', cs);
if (cs > 0 && ce > cs) { fs.writeFileSync(ASSETS + '/chart.umd.js', hmHtml.slice(cs, ce)); }

// 复制闪购素材资源（图片/视频）到中心目录 assets/shangou/
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  try { ensureDir(dst); } catch (e) { console.log('  ⚠ 无法创建目录 ' + dst + '：' + e.message + '（跳过素材同步，数据仍会写出）'); return 0; }
  let n = 0;
  try {
    fs.readdirSync(src).forEach(f => {
      const s = src + '/' + f, d = dst + '/' + f;
      try {
        if (fs.statSync(s).isDirectory()) n += copyDir(s, d);
        else { fs.copyFileSync(s, d); n++; }
      } catch (e) {
        console.log('  ⚠ 素材复制失败（不影响数据）: ' + f + ' — ' + e.message);
      }
    });
  } catch (e) {
    console.log('  ⚠ 读取素材目录失败（不影响数据）: ' + src + ' — ' + e.message);
  }
  return n;
}
const nImg = copyDir(SG_IMG_DIR, OUT + '/assets/shangou');
const nVid = copyDir(SG_VID_DIR, OUT + '/assets/shangou');
console.log('素材源: img=' + SG_IMG_DIR + '  vid=' + SG_VID_DIR);

console.log('=== 抽取完成 ===');
console.log('红猫 totals:', JSON.stringify(hm.totals));
console.log('品专 latest:', JSON.stringify(pz.latest), 'avgCtr:', pz.avgCtr, 'records:', pz.records.length, 'annual:', pz.annual.length, 'creatives:', pz.creatives.length, 'events:', pz.events.length);
console.log('闪购 overall:', JSON.stringify(sg.overall), 'daily:', sg.daily.length, 'byCreative:', sg.byCreative.length, 'byPin:', sg.byPin.length, 'byPlan:', sg.byPlan.length, 'byUnit:', sg.byUnit.length, 'byAudience:', sg.byAudience.length, 'lowCtr:', sg.optimization.lowCtr.length);
console.log('资源复制: images', nImg, 'videos', nVid);
console.log('已写出: data/{hongmao,pinzuan,shangou}.js + assets/chart.umd.js + assets/shangou/*');
