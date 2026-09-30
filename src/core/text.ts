// 字数按 Unicode 码点计算；检查原文，避免 trim 吃掉控制字符。
export function singleLine(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new Error(`${label}请写 ${min}–${max} 字，不能含控制字符。`);
  }
  const text = value.trim();
  if ([...text].length < min || [...text].length > max) throw new Error(`${label}请写 ${min}–${max} 字。`);
  return text;
}

// 字节换成给人看的 MB，命令行（xagents slim）和设置页共用这一份。
// 换算（1 MB = 1,000,000 字节）：10 MB 以上取整，以下一位小数、整数不写小数；大于 0 但不足 0.1 MB 写“不到 0.1 MB”。
export function megabytes(bytes: number): string {
  if (!(bytes > 0)) return '0 MB';
  if (bytes < 1e5) return '不到 0.1 MB';
  const mb = bytes / 1e6;
  return (mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1).replace(/\.0$/, '')) + ' MB';
}

// 大数写成“万”“亿”（token 这类），命令行和界面共用：不到 1 万写原数（千分位），1 万起一位小数，整数不写小数。
export function compactCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n), one = (v: number) => v.toFixed(1).replace(/\.0$/, '');
  if (abs < 1e4) return Math.round(n).toLocaleString('en-US');
  if (abs < 1e8) return one(n / 1e4) + ' 万';
  return one(n / 1e8) + ' 亿';
}
