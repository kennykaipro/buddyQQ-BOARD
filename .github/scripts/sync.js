/**
 * GitHub Actions 版每日同步脚本
 *
 * 读取 kennykaipro/bidding-board 的 data/data.json，按与本地 sync_bid_data.js
 * 完全相同的规则筛选、转换、合并内置深度数据、应用链接修正，输出 data.json。
 * 由 workflow 负责 git commit/push，本脚本不需要 token。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = process.cwd();
const SRC_URL = 'https://raw.githubusercontent.com/kennykaipro/bidding-board/main/data/data.json';

const BIZ_MAP = {
  '音视频': '音视频系统', '视频会议': '会议系统', '会议': '会议系统',
  '舞台灯光': '舞台灯光', '灯光': '舞台灯光', '舞台机械': '舞台机械',
  '扩声': '扩声系统', '音响': '扩声系统', '音频': '扩声系统',
  '中控': '中控系统', '多媒体': '多媒体系统',
  'LED': 'LED显示', 'LED显示': 'LED显示', '显示': 'LED显示',
  '投影': '多媒体系统', '智能化': '智能化工程', '系统集成': '系统集成'
};
const STRONG_KW = ['音视频','视频会议','会议系统','会议','舞台','灯光','音响','扩声','LED','多媒体','中控','投影','报告厅','剧场','礼堂','演播','学术报告','智慧校园','智慧园区'];
const GD_CITIES = ['广州','深圳','东莞','佛山','珠海','中山','惠州','汕头','湛江','江门','肇庆','清远','韶关','河源','梅州','汕尾','阳江','茂名','潮州','揭阳','云浮','顺德','南海','宝安','龙岗','南山','福田','罗湖','龙华','坪山','光明'];

function fetchSource() {
  return new Promise((resolve, reject) => {
    https.get(SRC_URL, { headers: { 'User-Agent': 'yale-board-daily-sync' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchSourceUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('读取源数据失败: HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('源数据 JSON 解析失败')); }
      });
    }).on('error', reject);
  });
}

function fetchSourceUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'yale-board-daily-sync' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('重定向读取失败: HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function extractBaseData() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/const BASE_DATA = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('无法从 index.html 提取 BASE_DATA');
  return new Function('return ' + m[1])();
}

function mapBiz(keywords) {
  const out = new Set();
  (keywords || []).forEach(k => {
    for (const [key, val] of Object.entries(BIZ_MAP)) {
      if (k.includes(key) || key.includes(k)) out.add(val);
    }
  });
  return [...out];
}

function convertItem(item) {
  const title = item.title || '';
  const kws = item.matched_keywords || [];
  const biz = mapBiz(kws);
  const city = GD_CITIES.find(c => title.includes(c)) || '';
  const date = item.date || '';
  const isBid = item.stage === '招标';
  const hash = require('crypto').createHash('md5').update(item.url || title).digest('hex').slice(0, 8);
  const id = 'D' + hash;
  const summary = `来源：${item.source_name || item.source || '未知'} ｜ 关键词：${(kws.join('、') || '未标注')} ｜ 发布日期：${date}`;
  return {
    id,
    category: isBid ? 'open' : 'yale',
    name: title,
    type: isBid ? '在招项目' : '历史项目',
    region: '广东',
    city,
    amount: 0,
    budget: 0,
    winner: '',
    date,
    due: '',
    deadline: '',
    bidMethod: '',
    biz: biz.length ? biz : ['其他'],
    fit: 'track',
    local: true,
    tags: ['每日抓取', isBid ? '在招' : (item.stage || '历史'), ...(kws || []).slice(0, 3)],
    summary,
    detail: `由每日自动同步生成。原始标题：${title}。请点击来源链接核实详情、预算与截止日期。`,
    source: item.source_name || item.source || '未知来源',
    sourceUrl: item.url || '',
    follow: false
  };
}

function filterRelevant(items) {
  return items.filter(it => {
    const title = it.title || '';
    const isGD = String(it.province || '').includes('广东') || title.includes('广东') || GD_CITIES.some(c => title.includes(c));
    if (!isGD) return false;
    const kws = it.matched_keywords || [];
    const all = title + ' ' + kws.join(' ');
    return STRONG_KW.some(k => all.includes(k));
  });
}

(async () => {
  const src = await fetchSource();
  console.log('源数据生成时间:', src.generated_at, '总条目:', (src.items || []).length);
  const relevant = filterRelevant(src.items || []);
  console.log('命中:', relevant.length);

  const base = extractBaseData();
  const map = new Map();
  base.forEach(d => map.set(d.id, d));
  relevant.forEach(it => {
    const conv = convertItem(it);
    if (!map.has(conv.id)) map.set(conv.id, conv);
  });

  const fixFile = path.join(ROOT, '.github', 'scripts', 'url_fixes.json');
  let fixed = 0;
  if (fs.existsSync(fixFile)) {
    const fixes = JSON.parse(fs.readFileSync(fixFile, 'utf8')).fixes || {};
    map.forEach(d => {
      const f = fixes[d.id];
      if (f && f.sourceUrl) {
        d.sourceUrl = f.sourceUrl;
        if (f.source) d.source = f.source;
        fixed++;
      }
    });
  }
  console.log('已应用链接修正:', fixed);

  const all = [...map.values()];
  const openCnt = all.filter(d => d.category === 'open').length;
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const stamp = bj.toISOString().replace('T', ' ').slice(0, 16) + ' (北京时间)';
  const out = {
    generated_at: stamp,
    source_generated_at: src.generated_at,
    source_total: (src.items || []).length,
    matched_count: relevant.length,
    total: all.length,
    open_count: openCnt,
    projects: all
  };
  fs.writeFileSync(path.join(ROOT, 'data.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('已生成 data.json 总项目', all.length, '在招', openCnt, '更新时间', stamp);
})().catch(e => { console.error('同步失败:', e.message); process.exit(1); });
