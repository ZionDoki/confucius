import type { TaskTraceReport } from "@confucius/protocol";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

export function taskTraceFilename(taskId: string, now = Date.now()): string {
  return `confucius-trace-${taskId.replace(/[^\w-]/g, "_").slice(0, 80) || "task"}-${new Date(now).toISOString().replace(/[:.]/g, "-")}.html`;
}

/** One offline file: lazy-rendered details and the entire sanitized JSON payload. */
export function renderTaskTraceHtml(report: TaskTraceReport): string {
  const data = JSON.stringify(report)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(report.task.title)} · Confucius trace</title>
<style>
:root{color-scheme:light dark;font:14px/1.6 system-ui,sans-serif;background:#f6f5f2;color:#242a31}*{box-sizing:border-box}body{max-width:1120px;margin:0 auto;padding:36px 24px 80px}h1{font-size:28px;line-height:1.25;margin:10px 0}h2{font-size:19px;margin-top:30px}.muted{color:#66717a}.eyebrow{font-size:12px;letter-spacing:.1em}.meta{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.meta span,details,article{background:#fff;border:1px solid #dfe1e4;border-radius:8px}.meta span{padding:6px 12px}button,input{font:inherit;padding:8px 12px;border:1px solid #c8cdd2;border-radius:6px;background:#fff;color:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #2c6eb6;outline-offset:2px}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0}input{flex:1;min-width:200px}details{margin:8px 0;padding:10px 14px}summary{cursor:pointer;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;max-height:70vh;overflow:auto;margin:12px 0 0;padding-top:10px;border-top:1px solid #dfe1e4}.issues{border-left:3px solid #c17922;padding-left:16px}.event{display:grid;grid-template-columns:88px 1fr;gap:10px}.event time{font:12px/1.6 ui-monospace,monospace;color:#66717a}.event .kind{font-weight:600}.event .summary{color:#52616c;margin-left:10px}.fail{border-left:3px solid #bd3f3f}#pager{justify-content:flex-end}noscript{display:block;padding:16px;border:1px solid #c17922}@media(prefers-color-scheme:dark){:root{background:#181b20;color:#e3e6eb}.meta span,details,article,button,input{background:#232830;border-color:#39424d}.muted,.event time,.event .summary{color:#a7b3c1}pre{border-color:#39424d}}@media print{button,input,#pager{display:none}body{padding:0}pre{max-height:none}}
</style></head><body>
<div class="eyebrow muted">CONFUCIUS · 任务诊断报告 / TASK TRACE</div>
<h1>${escapeHtml(report.task.title)}</h1>
<div class="muted">${escapeHtml(report.task.id)} · ${escapeHtml(new Date(report.capture.startedAt).toISOString())}</div>
<div class="meta"><span>${escapeHtml(report.task.backend)}</span><span>${escapeHtml(report.task.status)}</span><span>${report.events.length} events</span><span>${report.capture.running ? "运行中快照" : "任务快照"}</span></div>
<div class="toolbar"><button id="download" type="button">下载完整 JSON</button><span class="muted">已移除凭据；任务文本与引用材料保留，分享前请检查内容。</span></div>
<div id="issues" class="issues" role="status"></div>
<h2>记录范围</h2><ul id="coverage"></ul>
<h2>事件时间线</h2><div class="toolbar"><input id="filter" type="search" placeholder="搜索事件、工具、错误或内容" aria-label="搜索事件"><span id="count" class="muted"></span></div><div id="events"></div>
<div class="toolbar" id="pager"><button id="previous" type="button">上一页</button><span id="page"></span><button id="next" type="button">下一页</button></div>
<h2>完整记录</h2><p class="muted">点击展开原始结构；事件分页只影响显示，JSON 包含全部导出记录。</p><div id="sections"></div>
<noscript>此报告需要 JavaScript 展开记录。完整 JSON 保存在本文件的 confucius-trace-data 元素中。</noscript>
<script type="application/json" id="confucius-trace-data">${data}</script>
<script>
const report=JSON.parse(document.getElementById('confucius-trace-data').textContent);
const add=(tag,parent,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;parent.append(node);return node};
const pretty=value=>JSON.stringify(value,null,2);
const detail=(parent,label,value)=>{const d=add('details',parent);add('summary',d,label);d.addEventListener('toggle',()=>{if(d.open&&!d.querySelector('pre'))add('pre',d,pretty(value))});return d};
const labels={state:'任务、预算与恢复检查点',history:'跨窗口历史与工作笔记',pendingHistory:'待持久化历史',operations:'操作 intent 与 receipt',annotationProposals:'批注候选',artifacts:'成果与版本',environment:'运行环境与配置'};
for(const text of report.coverage)add('li',document.getElementById('coverage'),text);
const issues=[...report.issues];if(report.capture.changedDuringExport)issues.unshift('任务在导出期间发生了变化，各部分采集时间见 capturedAt。');
for(const text of issues)add('p',document.getElementById('issues'),text);
for(const [key,value] of Object.entries(report.sections))detail(document.getElementById('sections'),labels[key]||key,value);
detail(document.getElementById('sections'),'脱敏统计',report.redactions);
let page=0,filtered=report.events;const size=100;
const render=()=>{const target=document.getElementById('events');target.replaceChildren();for(const event of filtered.slice(page*size,(page+1)*size)){const payload=event.payload||{};const summary=payload.toolName||payload.name||payload.stopReason||payload.reason||payload.message||payload.text||payload.result?.message||'';const d=detail(target,new Date(event.ts).toISOString()+' · '+event.type+' · '+String(summary).replace(/\\s+/g,' ').slice(0,160),event);if(event.type.includes('fail')||payload.result?.ok===false)d.classList.add('fail')}document.getElementById('count').textContent=filtered.length+' / '+report.events.length;document.getElementById('page').textContent=(page+1)+' / '+Math.max(1,Math.ceil(filtered.length/size));document.getElementById('previous').disabled=page===0;document.getElementById('next').disabled=(page+1)*size>=filtered.length};
document.getElementById('filter').addEventListener('input',event=>{const query=event.target.value.toLocaleLowerCase();filtered=report.events.filter(item=>pretty(item).toLocaleLowerCase().includes(query));page=0;render()});
document.getElementById('previous').onclick=()=>{page--;render()};document.getElementById('next').onclick=()=>{page++;render()};
document.getElementById('download').onclick=()=>{const url=URL.createObjectURL(new Blob([pretty(report)],{type:'application/json'}));const a=add('a',document.body);a.href=url;a.download='confucius-trace-'+report.task.id.replace(/[^\\w-]/g,'_')+'.json';a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)};
render();
</script></body></html>`;
}
