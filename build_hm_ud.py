# -*- coding: utf-8 -*-
"""红猫 UD 明细抽取器

从 4 个品类 xlsx 的 UD 明细 sheet 聚合「投放主体 × 投放位置 × 优化目标」，
并 join 聚光（计划-投放数据）sheet 的 店铺访问量 / 访问成本。
产出 window.DASH.hongmaoUd，供统一看板「二、投放数据」渲染。

设计要点 / 踩过的坑
1. sheet 名与列位在不同品类文件中不一致（'UD' / 'UD数据'；col61 有时是「投放主体」有时是「商品ID」），
   因此列位一律按 **表头文字** 解析，不写死索引。
2. 「计划-投放数据」与「创意 / 素材数据」sheet 表头完全相同，两张一起抓会把访问量翻倍
   （曾踩：13,463 → 26,926）。因此只取 1 张，按名字优先级选。
3. 访问量只能 join 一次：先把 UD 明细按 (主体,位置,目标) 聚合，再逐叶 join，
   绝不能按 UD 行数逐行累加（曾踩：13,463 → 12,748,406）。
4. 少数叶子在聚光里没有对应行；按花费比例分摊聚光残差，保证明细合计 == 聚光总计。
5. 输出用短键 + 一叶一行，便于人读与增量维护（页面侧负责派生 ctr/cpm/cpc/roi/间接/退款率/访问成本）。
"""
import zipfile, xml.etree.ElementTree as ET, re, json, os, io, sys

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

SRC = [
    ('nb_0621',     r'D:/桌面/红猫数据/6.8-6.21日红猫数据-NB.xlsx',     '笔记本 6.8-6.21'),
    ('nb_0825',     r'D:/桌面/红猫数据/8.18-9.14日红猫数据-NB.xlsx',   '笔记本 8.18-9.14'),
    ('phone_0728',  r'D:/桌面/红猫数据/7.17-7.28日红猫数据-手机.xlsx',  '手机 7.17-7.28'),
    ('tablet_0906', r'D:/桌面/红猫数据/8.25-9.15日红猫数据-平板.xlsx',  '平板 8.25-9.15'),
]
WORK = os.path.dirname(os.path.abspath(__file__))


def _outdir():
    """输出目录：--out <dir> 优先；否则自动探测看板中心；再不行退回脚本所在目录。"""
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == '--out' and i + 1 < len(argv):
            return os.path.abspath(argv[i + 1])
    cand = r'D:/桌面/看板中心/data'
    if os.path.isdir(os.path.dirname(cand)):
        return cand
    return WORK


OUTDIR   = _outdir()
OUT_JS   = os.path.join(OUTDIR, 'hongmao_ud.js')
OUT_JSON = os.path.join(OUTDIR, 'hongmao_ud.json')
REPORT   = os.path.join(OUTDIR, 'hongmao_ud_report.txt')

# 前端列定义（顺序即表格列顺序）；src: ud=UD口径 / jg=聚光口径
COLS = [
    ('spend',    '花费',         'ud', 'money'),
    ('imp',      '曝光量',       'ud', 'int'),
    ('clk',      '点击量',       'ud', 'int'),
    ('ctr',      '点击率',       'ud', 'pct'),
    ('conv_n',   '总成交笔数',   'ud', 'int'),
    ('conv_gmv', '总成交金额',   'ud', 'money'),
    ('cpm',      'CPM',          'ud', 'money2'),
    ('cpc',      'CPC',          'ud', 'money2'),
    ('conv_roi', '总成交ROI',    'ud', 'roi'),
    ('net_gmv',  '剔退GMV',      'ud', 'money'),
    ('net_roi',  '剔退ROI',      'ud', 'roi'),
    ('dir_n',    '直接成交笔数', 'ud', 'int'),
    ('dir_gmv',  '直接成交金额', 'ud', 'money'),
    ('dir_roi',  '直接成交ROI',  'ud', 'roi'),
    ('ind_n',    '间接成交笔数', 'ud', 'int'),
    ('ind_gmv',  '间接成交金额', 'ud', 'money'),
    ('ind_roi',  '间接成交ROI',  'ud', 'roi'),
    ('ref_n',    '总退款笔数',   'ud', 'int'),
    ('ref_amt',  '总退款金额',   'ud', 'money'),
    ('ref_rate', '总退款率',     'ud', 'pct'),
    ('visit',    '店铺访问量',   'jg', 'int'),
    ('vcost',    '访问成本',     'jg', 'money2'),
]
KEYS = [k for k, _, _, _ in COLS]
SHORT = {
    'spend': 'sp', 'imp': 'im', 'clk': 'ck', 'conv_n': 'cn', 'conv_gmv': 'cg',
    'net_gmv': 'ng', 'dir_n': 'dn', 'dir_gmv': 'dg', 'ref_n': 'rn', 'ref_amt': 'ra',
    'visit': 'vs', 'jg_spend': 'js',
}
SHORT_ORDER = ['spend', 'imp', 'clk', 'conv_n', 'conv_gmv', 'net_gmv',
               'dir_n', 'dir_gmv', 'ref_n', 'ref_amt', 'visit', 'jg_spend']


def r2(v):
    return round(float(v), 2)


# ---------------- xlsx 低层 ----------------
def ci(ref):
    m = re.match(r'([A-Z]+)', ref or '')
    c = 0
    for ch in (m.group(1) if m else ''):
        c = c * 26 + (ord(ch) - 64)
    return c - 1


def load_book(path):
    z = zipfile.ZipFile(path)
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rid2t = {r.attrib['Id']: r.attrib['Target'] for r in rels}
    sh = {}
    for s in wb.find(NS + 'sheets'):
        tgt = rid2t.get(s.attrib.get(RNS + 'id', ''), '')
        if tgt and not tgt.startswith('xl/'):
            tgt = 'xl/' + tgt.lstrip('/')
        sh[s.attrib.get('name', '')] = tgt
    try:
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        ss = [''.join(t.text or '' for t in si.iter(NS + 't')) for si in root.findall(NS + 'si')]
    except KeyError:
        ss = []
    return z, sh, ss


def cv(c, ss):
    t = c.get('t')
    if t == 'inlineStr':
        return ''.join(x.text or '' for x in c.iter(NS + 't'))
    v = c.find(NS + 'v')
    if v is None:
        return ''
    if t == 's':
        i = int(int(v.text))
        return ss[i] if 0 <= i < len(ss) else ''
    return v.text or ''


def sheet_rows(z, tgt, ss):
    root = ET.fromstring(z.read(tgt))
    out = []
    for r in root.find(NS + 'sheetData').findall(NS + 'row'):
        d = {}
        for c in r.findall(NS + 'c'):
            d[ci(c.get('r'))] = cv(c, ss)
        out.append(d)
    return out


def hdr(d):
    return {str(v).strip(): k for k, v in d.items() if str(v).strip()}


def pick(h, *names):
    for n in names:
        for k, idx in h.items():
            if k == n or k.startswith(n):
                return idx
    return None


def num(v):
    try:
        return float(v or 0)
    except Exception:
        return 0.0


def norm_key(v):
    s = str(v or '').strip()
    return '(未标注)' if s in ('', '#N/A', '#n/a', 'N/A', 'None', 'nan') else s


def blank():
    return {k: 0.0 for k in KEYS}


def finalize(d):
    sp, imp, clk = d['spend'], d['imp'], d['clk']
    d['ctr']      = clk / imp * 100 if imp else 0.0
    d['cpm']      = sp / imp * 1000 if imp else 0.0
    d['cpc']      = sp / clk if clk else 0.0
    d['conv_roi'] = d['conv_gmv'] / sp if sp else 0.0
    d['net_roi']  = d['net_gmv'] / sp if sp else 0.0
    d['dir_roi']  = d['dir_gmv'] / sp if sp else 0.0
    d['ind_n']    = max(d['conv_n'] - d['dir_n'], 0.0)
    d['ind_gmv']  = max(d['conv_gmv'] - d['dir_gmv'], 0.0)
    d['ind_roi']  = d['ind_gmv'] / sp if sp else 0.0
    d['ref_rate'] = d['ref_n'] / d['conv_n'] * 100 if d['conv_n'] else 0.0
    d['vcost']    = d.get('jg_spend', 0.0) / d['visit'] if d['visit'] else 0.0
    return d


# ---------------- 单文件 ----------------
def parse_period(path):
    z, sh, ss = load_book(path)
    cache = {}
    for nm, tgt in sh.items():
        try:
            cache[nm] = sheet_rows(z, tgt, ss)
        except Exception:
            cache[nm] = []

    # 1) 商品ID → 商品名称
    id2name = {}
    for nm, rows in cache.items():
        if not rows:
            continue
        h = hdr(rows[0])
        n_idx, i_idx = pick(h, '商品名称', '投放主体'), pick(h, '商品ID')
        if n_idx is not None and i_idx is not None and len(rows) > 1:
            head = str(rows[0].get(n_idx, '')).strip()
            for r in rows[1:]:
                nmv = str(r.get(n_idx, '') or '').strip()
                piv = str(r.get(i_idx, '') or '').strip()
                if nmv and piv and nmv != head:
                    id2name[piv] = nmv
            if id2name:
                break

    # 2) 聚光：只取 1 张「计划级」sheet
    cands = []
    for nm, rows in cache.items():
        if not rows:
            continue
        h = hdr(rows[0])
        i_pos, i_goal = pick(h, '投放位置', '投放版位'), pick(h, '优化目标')
        i_goods = pick(h, '商品ID', '商品Id')
        i_spend, i_visit = pick(h, '消费'), pick(h, '店铺访问量')
        if None in (i_pos, i_goal, i_spend, i_visit):
            continue
        pref = 0 if nm.startswith('计划-投放数据') else (1 if nm == '投放计划' else 2)
        cands.append((pref, len(rows), nm, rows, h, i_pos, i_goal, i_goods, i_spend, i_visit))
    jg, jg_by = {}, {'subject': {}, 'pos': {}, 'goal': {}, 'total': {'spend': 0.0, 'visit': 0.0}}
    if cands:
        cands.sort(key=lambda x: (x[0], x[1]))
        _, _, _, rows, h, i_pos, i_goal, i_goods, i_spend, i_visit = cands[0]

        def bump(d, k, sp, vs):
            a = d.setdefault(k, {'spend': 0.0, 'visit': 0.0})
            a['spend'] += sp; a['visit'] += vs

        for r in rows[1:]:
            if not str(r.get(0, '') or '').strip():
                continue
            gid = str(r.get(i_goods, '') or '').strip() if i_goods is not None else ''
            subj = norm_key(id2name.get(gid, gid))
            pos, goal = norm_key(r.get(i_pos)), norm_key(r.get(i_goal))
            sp, vs = num(r.get(i_spend)), num(r.get(i_visit))
            bump(jg, (subj, pos, goal), sp, vs)
            bump(jg_by['subject'], subj, sp, vs)
            bump(jg_by['pos'], pos, sp, vs)
            bump(jg_by['goal'], goal, sp, vs)
            jg_by['total']['spend'] += sp; jg_by['total']['visit'] += vs

    # 3) UD 明细
    ud = None
    for nm in ('UD', 'UD数据'):
        if nm in cache and cache[nm]:
            ud = cache[nm]; break
    if ud is None:
        for nm, rows in cache.items():
            if 'UD' in nm and '透视' not in nm and rows:
                ud = rows; break
    if not ud:
        return None
    h = hdr(ud[0])
    C = dict(date=0, spend=pick(h, '花费'), imp=pick(h, '展现量'), clk=pick(h, '点击量'),
             conv_n=pick(h, '总成交笔数'), conv_gmv=pick(h, '总成交金额'),
             net_gmv=pick(h, '总成交金额(剔除退款)'),
             dir_n=pick(h, '直接成交笔数'), dir_gmv=pick(h, '直接成交金额'),
             ref_n=pick(h, '总退款订单数'), ref_amt=pick(h, '总退款金额'),
             subj=pick(h, '投放主体'), goods=pick(h, '商品ID'),
             pos=pick(h, '投放位置', '投放版位'), goal=pick(h, '优化目标'))
    if None in (C['spend'], C['pos'], C['goal']) or (C['subj'] is None and C['goods'] is None):
        return None

    leaves = {}
    for r in ud[1:]:
        if not str(r.get(C['date'], '') or '').strip():
            continue
        if C['subj'] is not None:
            subj = norm_key(r.get(C['subj']))
        else:
            gid = str(r.get(C['goods'], '') or '').strip()
            subj = norm_key(id2name.get(gid, gid))
        pos, goal = norm_key(r.get(C['pos'])), norm_key(r.get(C['goal']))
        k = (subj, pos, goal)
        m = leaves.setdefault(k, blank())
        m['spend'] += num(r.get(C['spend'])); m['imp'] += num(r.get(C['imp'])); m['clk'] += num(r.get(C['clk']))
        m['conv_n'] += num(r.get(C['conv_n'])); m['conv_gmv'] += num(r.get(C['conv_gmv']))
        m['net_gmv'] += num(r.get(C['net_gmv'])) if C['net_gmv'] is not None else 0.0
        m['dir_n'] += num(r.get(C['dir_n'])); m['dir_gmv'] += num(r.get(C['dir_gmv']))
        m['ref_n'] += num(r.get(C['ref_n'])); m['ref_amt'] += num(r.get(C['ref_amt']))

    # 叶子：先精确 join 聚光，未匹配的按花费比例分摊残差（保证合计一致）
    out, matched = [], set()
    for (subj, pos, goal), m in leaves.items():
        if m['spend'] <= 0 and m['conv_gmv'] <= 0 and m['conv_n'] <= 0:
            continue
        g = jg.get((subj, pos, goal))
        if g:
            m['visit'] = g['visit']; m['jg_spend'] = g['spend']
            matched.add((subj, pos, goal))
        finalize(m)
        m['s'], m['p'], m['g'] = subj, pos, goal
        out.append(m)
    mv = sum(m['visit'] for m in out)
    ms = sum(m.get('jg_spend', 0.0) for m in out)
    rest = [m for m in out if (m['s'], m['p'], m['g']) not in matched]
    rs_spend = sum(m['spend'] for m in rest)
    if rest and rs_spend > 0:
        rv = max(jg_by['total']['visit'] - mv, 0.0)
        rss = max(jg_by['total']['spend'] - ms, 0.0)
        for m in rest:
            w = m['spend'] / rs_spend
            m['visit'] = rv * w; m['jg_spend'] = rss * w
            finalize(m)
    out.sort(key=lambda x: -x['spend'])

    # 聚光原生分维度聚合（商品/版位/目标/整体）
    def rows_of(d):
        return [[k, r2(v['spend']), r2(v['visit'])] for k, v in sorted(d.items(), key=lambda x: -x[1]['spend'])]
    return {
        'leaves': out,
        'jgS': rows_of(jg_by['subject']),
        'jgP': rows_of(jg_by['pos']),
        'jgG': rows_of(jg_by['goal']),
        'jgT': [r2(jg_by['total']['spend']), r2(jg_by['total']['visit'])],
        'nMatched': len(matched),
        'nLeaves': len(out),
    }


# ---------------- 输出 ----------------
def leaf_line(m):
    parts = ['"s":"%s"' % m['s'], '"p":"%s"' % m['p'], '"g":"%s"' % m['g']]
    for k in SHORT_ORDER:
        parts.append('"%s":%s' % (SHORT[k], r2(m.get(k, 0))))
    return '     {' + ','.join(parts) + '}'


def dump_js(data):
    L = ['window.DASH = window.DASH || {};', 'window.DASH.hongmaoUd = {']
    L.append(' "updatedAt":"%s",' % data['updatedAt'])
    L.append(' "cols":[' + ','.join(
        '{"key":"%s","label":"%s","src":"%s","fmt":"%s"}' % (k, lb, sc, fm) for k, lb, sc, fm in COLS) + '],')
    L.append(' "periods":{')
    items = list(data['periods'].items())
    for pi, (key, p) in enumerate(items):
        L.append('  "%s":{"label":"%s","jgT":[%s,%s],' % (
            key, p['label'], p['jgT'][0], p['jgT'][1]))
        for tag in ('jgS', 'jgP', 'jgG'):
            L.append('   "%s":[%s],' % (tag, ','.join('["%s",%s,%s]' % (a, b, c) for a, b, c in p[tag])))
        L.append('   "leaves":[')
        for li, m in enumerate(p['leaves']):
            L.append(leaf_line(m) + (',' if li < len(p['leaves']) - 1 else ''))
        L.append('   ]')
        L.append('  }' + (',' if pi < len(items) - 1 else ''))
    L.append(' }')
    L.append('};')
    return '\n'.join(L) + '\n'


def main():
    periods, jg_all = {}, {'subject': {}, 'pos': {}, 'goal': {}, 'total': {'spend': 0.0, 'visit': 0.0}}
    merged_leaves = {}
    for key, path, label in SRC:
        if not os.path.isfile(path):
            print('  [skip] %-12s 文件不存在' % key); continue
        try:
            r = parse_period(path)
        except Exception as e:
            print('  [err ] %-12s %s' % (key, e)); continue
        if not r:
            print('  [skip] %-12s 无 UD 明细 sheet（该品类不做 UD 口径）' % key); continue
        r['label'] = label
        periods[key] = r
        print('  %-12s 叶子=%-3d 精确匹配聚光=%-3d | 花费=%10.2f 访问=%9.0f | %s' % (
            key, r['nLeaves'], r['nMatched'], sum(m['spend'] for m in r['leaves']), r['jgT'][1], label))
        for m in r['leaves']:
            k = (m['s'], m['p'], m['g'])
            t = merged_leaves.setdefault(k, blank())
            for kk in KEYS:
                t[kk] += m.get(kk, 0.0)
            t['jg_spend'] = t.get('jg_spend', 0.0) + m.get('jg_spend', 0.0)
            t['s'], t['p'], t['g'] = k
        for tag, field in (('jgS', 'subject'), ('jgP', 'pos'), ('jgG', 'goal')):
            for a, sp, vs in r[tag]:
                x = jg_all[field].setdefault(a, {'spend': 0.0, 'visit': 0.0})
                x['spend'] += sp; x['visit'] += vs
        jg_all['total']['spend'] += r['jgT'][0]; jg_all['total']['visit'] += r['jgT'][1]

    if merged_leaves:
        leaves = []
        for (s, p, g), m in merged_leaves.items():
            if m['spend'] <= 0 and m['conv_gmv'] <= 0 and m['conv_n'] <= 0:
                continue
            finalize(m); m['s'], m['p'], m['g'] = s, p, g
            leaves.append(m)
        leaves.sort(key=lambda x: -x['spend'])
        def rows_of(d):
            return [[k, r2(v['spend']), r2(v['visit'])] for k, v in sorted(d.items(), key=lambda x: -x[1]['spend'])]
        periods['sum'] = {
            'label': '全周期汇总', 'leaves': leaves,
            'jgS': rows_of(jg_all['subject']), 'jgP': rows_of(jg_all['pos']), 'jgG': rows_of(jg_all['goal']),
            'jgT': [r2(jg_all['total']['spend']), r2(jg_all['total']['visit'])],
            'nLeaves': len(leaves), 'nMatched': len(leaves),
        }
        print('  %-12s 叶子=%-3d | 花费=%10.2f 访问=%9.0f' % (
            'sum', len(leaves), sum(m['spend'] for m in leaves), jg_all['total']['visit']))

    import datetime
    data = {'updatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), 'periods': periods}
    js = dump_js(data)
    open(OUT_JS, 'w', encoding='utf-8').write(js)
    open(OUT_JSON, 'w', encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=1))
    print('  -> %s (%.1f KB, %d 行)' % (OUT_JS, len(js.encode('utf-8')) / 1024.0, js.count(chr(10))))

    # 校验报表
    rep = io.StringIO()
    for key, p in periods.items():
        rep.write('\n' + '=' * 108 + '\n=== %s（%s）\n' % (key, p['label']))
        t = blank()
        for m in p['leaves']:
            for kk in KEYS:
                t[kk] += m.get(kk, 0.0)
            t['jg_spend'] = t.get('jg_spend', 0.0) + m.get('jg_spend', 0.0)
        t['visit'] = p['jgT'][1]; t['jg_spend'] = p['jgT'][0]
        finalize(t)
        rep.write('  合计：花费 %.2f | 曝光 %.0f | 点击 %.0f | 点击率 %.2f%% | 总成交 %d 笔 / %.2f | ROI %.2f\n' % (
            t['spend'], t['imp'], t['clk'], t['ctr'], t['conv_n'], t['conv_gmv'], t['conv_roi']))
        rep.write('        直接 %d 笔 / %.2f / ROI %.2f | 间接 %d 笔 / %.2f / ROI %.2f\n' % (
            t['dir_n'], t['dir_gmv'], t['dir_roi'], t['ind_n'], t['ind_gmv'], t['ind_roi']))
        rep.write('        退款 %d 笔 / %.2f / %.2f%% | 聚光访问 %.0f / 成本 %.2f\n' % (
            t['ref_n'], t['ref_amt'], t['ref_rate'], t['visit'], t['vcost']))
        rep.write('\n  -- 叶子（投放主体 × 投放位置 × 优化目标），按花费降序 --\n')
        f = '  %-14s %-8s %-8s %9s %8s %7s %7s %7s %10s %7s %6s %7s %7s %10s %7s %7s %10s %7s %6s %10s %6s\n'
        rep.write(f % ('投放主体', '投放位置', '优化目标', '花费', '曝光量', '点击量', '点击率', '总成交笔', '总成交金额',
                       'CPM', 'CPC', '总成交ROI', '直接笔', '直接金额', '直接ROI', '间接笔', '间接金额', '间接ROI',
                       '退款笔', '退款金额', '退款率'))
        for m in p['leaves']:
            rep.write(f % (m['s'], m['p'], m['g'], '%.2f' % m['spend'], '%.0f' % m['imp'], '%.0f' % m['clk'],
                           '%.2f%%' % m['ctr'], '%.0f' % m['conv_n'], '%.2f' % m['conv_gmv'],
                           '%.2f' % m['cpm'], '%.2f' % m['cpc'], '%.2f' % m['conv_roi'],
                           '%.0f' % m['dir_n'], '%.2f' % m['dir_gmv'], '%.2f' % m['dir_roi'],
                           '%.0f' % m['ind_n'], '%.2f' % m['ind_gmv'], '%.2f' % m['ind_roi'],
                           '%.0f' % m['ref_n'], '%.2f' % m['ref_amt'], '%.2f%%' % m['ref_rate']))
        for tag, name in (('jgS', '按投放主体'), ('jgP', '按投放位置'), ('jgG', '按优化目标')):
            rep.write('\n  -- %s（聚光口径）--\n' % name)
            for a, sp, vs in p[tag]:
                rep.write('     %-14s 消费 %10.2f | 店铺访问 %8.0f | 访问成本 %6.2f\n' % (a, sp, vs, (sp / vs) if vs else 0))
    open(REPORT, 'w', encoding='utf-8').write(rep.getvalue())
    print('  -> %s' % REPORT)


main()
