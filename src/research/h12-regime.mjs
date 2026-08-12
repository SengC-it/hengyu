function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function broadBearRegimeTimes(seriesBySymbol, {
  symbols,
  btcSymbol = 'BTCUSDT',
  fastBars = 60,
  slowBars = 180,
  minimumBreadth = 4
} = {}) {
  const reference = seriesBySymbol[btcSymbol];
  if (!reference) throw new Error(`missing regime reference: ${btcSymbol}`);
  for (const symbol of symbols) {
    const rows = seriesBySymbol[symbol];
    if (!rows || rows.length !== reference.length) throw new Error(`unaligned regime series: ${symbol}`);
    for (let index = 0; index < rows.length; index++) {
      if (rows[index].openTime !== reference[index].openTime) throw new Error(`regime timestamp mismatch: ${symbol}/${index}`);
    }
  }
  const eligible = new Set();
  for (let index = slowBars - 1; index < reference.length; index++) {
    const btcFast = average(reference.slice(index - fastBars + 1, index + 1).map(row => row.close));
    const btcSlow = average(reference.slice(index - slowBars + 1, index + 1).map(row => row.close));
    const breadth = symbols.filter(symbol => {
      const rows = seriesBySymbol[symbol];
      const slow = average(rows.slice(index - slowBars + 1, index + 1).map(row => row.close));
      return rows[index].close < slow;
    }).length;
    if (btcFast < btcSlow && reference[index].close < btcSlow && breadth >= minimumBreadth) {
      eligible.add(reference[index].openTime);
    }
  }
  return eligible;
}
