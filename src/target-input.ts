/** Daftar target menerima pemisah koma, baris baru, atau campuran keduanya. */
export function splitTargetInput(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((item) => String(item ?? "").split(/[\n,]/)).map((item) => item.trim()).filter(Boolean);
}
