"""Self-contained local inspection UI. No remote assets, fetches, or PDF scripts."""
import base64
import hashlib
import html
import json

STYLE = """
:root{font-family:system-ui,-apple-system,'PingFang SC',sans-serif;color:#172b38;background:#f4f6f7;line-height:1.5}*{box-sizing:border-box}body{margin:0}button,a{touch-action:manipulation}button{font:inherit;cursor:pointer;border:1px solid #cdd8de;background:white;border-radius:8px;padding:7px 11px;color:inherit}button:hover,button:focus-visible{border-color:#176c7b;outline:2px solid #b3dce1}button.active{background:#176c7b;color:#fff;border-color:#176c7b}header{background:#112d3a;color:white;padding:26px 32px}header .eyebrow{color:#a6dce1;font-size:12px;letter-spacing:2px}h1{font-size:25px;margin:8px 0}header p{margin:7px 0;color:#cddce2;max-width:1000px}a{color:#186d7d}header a{color:#a9e4e9}main{padding:22px 28px;max-width:1680px;margin:auto}.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}.stat{background:#fff;border:1px solid #dce4e8;border-radius:12px;padding:12px 18px;min-width:150px}.stat strong{font-size:24px;margin-right:8px}.notice{border-left:4px solid #d2a54d;background:#fff9eb;padding:12px 16px;border-radius:5px;font-size:14px;margin:16px 0}.metadata{font-size:12px;color:#56707e;overflow-wrap:anywhere}.tabs,.filters{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.workspace{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(340px,1fr);gap:20px;align-items:start}.source{background:#e2e9ed;padding:14px;border-radius:12px;position:sticky;top:12px}.source h2,.results h2{font-size:17px;margin:0 0 12px}.canvas{position:relative;background:#fff;line-height:0}.canvas>img{width:100%;display:block}.overlay{position:absolute;border:2px solid #ee6a26;background:rgba(255,156,66,.14);pointer-events:none;display:none}.caption{font-size:12px;color:#425e6b;line-height:1.7;margin:10px 0 0;overflow-wrap:anywhere}.cards{max-height:72vh;overflow:auto;padding-right:5px}.card{background:#fff;border:1px solid #d9e2e7;border-radius:10px;padding:14px;margin-bottom:10px;scroll-margin:10px}.card.selected{border:2px solid #d77239;padding:13px}.card header{background:none;padding:0;color:inherit;display:flex;justify-content:space-between;align-items:center;gap:8px}.badge{border-radius:4px;font-size:12px;background:#e8f3f5;color:#235b67;padding:2px 6px}.card p{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}.card img{width:100%;max-height:260px;object-fit:contain;background:#f5f7f8;margin-top:10px}.card .loc{font-family:ui-monospace,monospace;font-size:11px;color:#55707e;overflow-wrap:anywhere}.card button{font-size:12px}.tablewrap{overflow:auto;margin-top:10px}table{border-collapse:collapse;font-size:12px;min-width:100%}td{border:1px solid #cfdae0;padding:6px;white-space:pre-wrap;max-width:220px}.empty{background:#fff;padding:24px;border-radius:10px;color:#607480}.issues{color:#9d431e;font-size:13px}.footer{margin-top:24px;border-top:1px solid #d7e0e5;padding-top:16px;color:#4f6875;font-size:13px}details{margin-top:12px}summary{cursor:pointer;font-weight:600}li{margin:5px 0}@media(max-width:850px){header{padding:20px}main{padding:15px}.workspace{grid-template-columns:1fr}.source{position:static}.cards{max-height:none}.stat{min-width:130px;flex:1}.stat strong{font-size:21px}}
"""

SCRIPT = """
const data=JSON.parse(document.getElementById('data').textContent);
const labels={paragraph:'文字行',image:'图片区域',table:'表格候选',other:'未支持页'};
const statuses={parsed:'已提取原生文字',extracted_not_understood:'已提取区域 · 未理解',candidate_not_reviewed:'候选 · 未审查',unsupported:'未支持',failed:'失败'};
let pageIndex=0,filter='all',selected=null;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
const pages=document.getElementById('pages'),filters=document.getElementById('filters'),cards=document.getElementById('cards');
function bboxText(b){const q=b.location.bbox;return `P${b.location.page} · ${b.blockId} · x=${q.x.toFixed(1)} y=${q.y.toFixed(1)} w=${q.width.toFixed(1)} h=${q.height.toFixed(1)} pt`;}
function highlight(b,card){selected=b.blockId;document.querySelectorAll('.card').forEach(n=>n.classList.toggle('selected',n===card));const p=data.pages[pageIndex],q=b.location.bbox,o=document.getElementById('overlay');o.style.cssText=`display:block;left:${q.x/p.width*100}%;top:${q.y/p.height*100}%;width:${q.width/p.width*100}%;height:${q.height/p.height*100}%`;document.getElementById('selection').textContent=bboxText(b);}
function render(){const p=data.pages[pageIndex];pages.replaceChildren();data.pages.forEach((item,i)=>{const n=el('button',String(i+1),i===pageIndex?'active':'');n.setAttribute('aria-label',`第 ${i+1} 页`);n.setAttribute('aria-pressed',String(i===pageIndex));n.onclick=()=>{pageIndex=i;selected=null;render()};pages.append(n)});
document.getElementById('page-title').textContent=`原文 · 第 ${p.page} / ${data.pages.length} 页`;
const img=document.getElementById('page-image');if(p.render){img.src=p.render;img.hidden=false}else{img.removeAttribute('src');img.hidden=true}img.alt=`PDF 第 ${p.page} 页原始渲染`;
document.getElementById('overlay').style.display='none';document.getElementById('selection').textContent='点击右侧“定位来源”，在原文中高亮区域。';
document.getElementById('page-meta').textContent=`${p.width.toFixed(1)} × ${p.height.toFixed(1)} pt · 旋转 ${p.rotation}° · 物理页码从 1 开始 · 左上角为原点`;
document.getElementById('page-issues').textContent=p.issues.map(i=>`${i.stage}: ${i.code}`).join('；');
filters.replaceChildren();for(const kind of ['all','paragraph','image','table','other']){const n=el('button',kind==='all'?'全部':`${labels[kind]} ${p.counts[kind]}`,filter===kind?'active':'');n.onclick=()=>{filter=kind;render()};filters.append(n)}
cards.replaceChildren();const bs=p.blocks.filter(b=>filter==='all'||b.type===filter);document.getElementById('result-title').textContent=`解析结果 · ${bs.length} 项`;
if(!bs.length){cards.append(el('div',filter==='table'?'此页未检出符合条件的矢量边框表格候选。无边框或图片中的表格尚未支持。':'此页没有此类解析结果。','empty'))}
for(const b of bs){const card=el('article',undefined,'card');card.dataset.blockId=b.blockId;const h=el('header');h.append(el('span',`${labels[b.type]} · ${statuses[b.status]}`,'badge'));const locate=el('button','定位来源');locate.onclick=()=>highlight(b,card);h.append(locate);card.append(h,el('p',bboxText(b),'loc'));
if(b.type==='paragraph')card.append(el('p',b.text));
if(b.type==='image'){card.append(el('p','来自 PDF 图片对象位置的页面裁剪；可能含叠加文字、遮罩或背景。未推断图片所表达的事实。'));}
if(b.asset){const crop=el('img');crop.src=b.asset;crop.alt=`${labels[b.type]} ${b.blockId} 来源区域`;crop.loading='lazy';card.append(crop)}
if(b.table){if(b.table.warnings.length)card.append(el('p','检测到空行或空合并行：文字可能落入相邻单元格，表头或末行可能遗漏，请核对原图。','issues'));const wrap=el('div',undefined,'tablewrap'),table=el('table');for(const row of b.table.rows){const tr=el('tr');for(const cell of row)tr.append(el('td',cell===null?'[合并/空单元格]':cell));table.append(tr)}wrap.append(table);card.append(wrap,el('p','单元格坐标保存在对应 tables JSON。与原生文字行可能重叠，不应当作两份独立证据。','metadata'))}
if(b.type==='other')card.append(el('p','未取得可用内容块。此页可能为空白、仅有矢量图形或需要 OCR。'));
cards.append(card)}
}
document.getElementById('title').textContent=data.source.name;
document.getElementById('source-hash').textContent=`原文件 ${data.source.sha256} · ${(data.source.bytes/1048576).toFixed(2)} MiB`;
const stats=document.getElementById('stats');for(const [kind,count] of [['pages',data.pages.length],...Object.entries(data.counts)]){if(kind==='other'&&!count)continue;const n=el('button',undefined,'stat');n.append(el('strong',String(count)),el('span',kind==='pages'?'原始页':labels[kind]));n.onclick=()=>{filter=kind==='pages'?'all':kind;const i=data.pages.findIndex(p=>filter==='all'||p.counts[filter]>0);if(i>=0)pageIndex=i;render()};stats.append(n)}
const limits=document.getElementById('limits');data.limitations.forEach(s=>limits.append(el('li',s)));
document.getElementById('engine').textContent=`${data.parser} · ${Object.entries(data.dependencies).map(([k,v])=>k+' '+v).join(' · ')}`;
render();
"""


def write_preview(path, manifest):
    payload = json.dumps(manifest, ensure_ascii=False).replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    script_hash = base64.b64encode(hashlib.sha256(SCRIPT.encode()).digest()).decode()
    path.write_text(f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-{script_hash}'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>{html.escape(manifest['source']['name'])} · PDF 来源检查</title><style>{STYLE}</style></head><body>
<header><div class="eyebrow">TJU MAS / LOCAL PDF INSPECTION</div><h1 id="title">PDF 来源检查</h1><p>查看原生文字、图片区域和表格候选，点击定位回到同一版本的原始页面。</p><p>本地解析预览 · 未进行 OCR、图片语义理解或事实审查 · 不代表最终企业展示页面</p>
<a href="source.pdf">原始 PDF 副本</a> · <a href="document-ir.json">DocumentIR</a> · <a href="manifest.json">解析清单</a></header>
<main><div id="stats" class="stats"></div><div id="source-hash" class="metadata"></div>
<div class="notice">表格均为检测候选，不能直接采纳为事实。图片展示的是原页区域裁剪；未识别图片中的文字、对象或含义。没有候选并不证明原文没有表格。</div>
<nav id="pages" class="tabs" aria-label="物理页码"></nav><div class="workspace"><section class="source"><h2 id="page-title"></h2><div class="canvas"><img id="page-image" alt="原始页面"><div id="overlay" class="overlay"></div></div><p id="selection" class="caption" aria-live="polite"></p><p id="page-meta" class="caption"></p><p id="page-issues" class="issues"></p></section>
<section class="results"><h2 id="result-title"></h2><div id="filters" class="filters" aria-label="结果类别"></div><div id="cards" class="cards"></div></section></div>
<div class="footer"><details open><summary>能力与限制</summary><ul id="limits"></ul></details><p id="engine" class="metadata"></p><p>所有文字行、区域、页面渲染和表格数据绑定原文件 SHA-256。仅支持本地文件；页面没有联网请求。</p></div></main>
<script type="application/json" id="data">{payload}</script><script>{SCRIPT}</script></body></html>''', encoding="utf-8")
