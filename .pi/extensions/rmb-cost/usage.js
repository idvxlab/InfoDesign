// 只统计用量元数据，不读取消息正文，不使用 Pi 已保存的美元 cost。
const categories = ['input', 'output', 'cacheRead', 'cacheWrite'];

export function estimateRmb(entries, prices) {
  if (prices.currency !== 'CNY' || prices.perTokens !== 1000000) {
    throw new Error('费率必须按 CNY／百万 token 配置');
  }
  for (const rates of Object.values(prices.models)) {
    for (const category of categories) {
      const rate = rates[category];
      if (rate !== null && (!Number.isFinite(rate) || rate < 0)) {
        throw new Error(`无效费率：${category}；未知价格应填 null`);
      }
    }
  }
  const amounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let unpricedEntries = 0;
  for (const entry of entries) {
    let usage;
    let modelKey;
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      usage = entry.message.usage;
      modelKey = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
    } else if (entry.type === 'usage') {
      usage = entry.usage;
      modelKey = `${entry.provider}/${entry.model}`;
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      usage = entry.usage;
    } else if (entry.type === 'message' && entry.message?.role === 'toolResult') {
      usage = entry.message.usage;
    } else {
      continue;
    }
    // 助手结果缺少 usage 时不能当作免费；普通工具或摘要可没有独立模型消耗。
    if (!usage) {
      if (entry.type === 'usage' || entry.message?.role === 'assistant') unpricedEntries++;
      continue;
    }
    if (!categories.every(key => Number.isFinite(usage[key]) && usage[key] >= 0)) {
      unpricedEntries++;
      continue;
    }
    const rates = prices.models[modelKey];
    let unpriced = false;
    for (const category of categories) {
      if (usage[category] === 0) continue;
      if (!rates || rates[category] === null) {
        unpriced = true;
        continue;
      }
      tokens[category] += usage[category];
      amounts[category] += usage[category] * rates[category] / prices.perTokens;
    }
    if (unpriced) unpricedEntries++;
  }
  return {
    total: Object.values(amounts).reduce((sum, value) => sum + value, 0),
    amounts, tokens, unpricedEntries,
  };
}

export function statusText(estimate) {
  const scope = estimate.unpricedEntries ? '已计部分' : '会话';
  const pending = estimate.unpricedEntries ? `；${estimate.unpricedEntries}条待定` : '';
  return `💰 ${scope}≈¥${estimate.total.toFixed(2)}（暂估${pending}）`;
}
