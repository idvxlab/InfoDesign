import { readFileSync } from 'node:fs';
import { estimateRmb, statusText } from './usage.js';

// 项目开发 Pi 的显示扩展，不添加模型工具、网络请求或消息正文。
export default function rmbCost(pi) {
  const prices = JSON.parse(readFileSync(new URL('./rates.json', import.meta.url), 'utf8'));
  estimateRmb([], prices); // 无效配置在加载时明确报错。
  const estimate = ctx => estimateRmb(ctx.sessionManager.getEntries(), prices);
  const update = (_event, ctx) => {
    if (ctx.mode === 'tui') ctx.ui.setStatus('rmb-cost', statusText(estimate(ctx)));
  };
  for (const event of ['session_start', 'turn_end', 'agent_end', 'agent_settled', 'session_compact', 'session_tree']) {
    pi.on(event, update);
  }
  pi.registerCommand('rmb-cost', {
    description: '查看按当前费率重算的人民币会话费用估算与价格假设',
    handler: async (_args, ctx) => {
      const result = estimate(ctx);
      update(undefined, ctx);
      if (!ctx.hasUI) return;
      const a = result.amounts;
      ctx.ui.notify([
        statusText(result),
        `普通输入 ¥${a.input.toFixed(4)}，输出 ¥${a.output.toFixed(4)}，缓存读取 ¥${a.cacheRead.toFixed(4)}，缓存写入 ¥${a.cacheWrite.toFixed(4)}`,
        prices.note,
        '统计整个会话文件（含压缩前记录）；按当前费率回算历史用量，不是账单或单条用户任务费用。',
        '无价格、无用量或无法确定模型的费用显示待定，不作为免费处理。/session 的美元金额与此估算独立。',
      ].join('\n'), 'info');
    },
  });
}
