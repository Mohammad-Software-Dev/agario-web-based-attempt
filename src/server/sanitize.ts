export function sanitizeName(input: unknown): string {
  if (typeof input !== 'string') return 'Cell';
  const cleaned = input.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
  return cleaned || 'Cell';
}
