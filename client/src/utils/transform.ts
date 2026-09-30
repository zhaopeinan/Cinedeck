// Convert snake_case object keys to camelCase
export function toCamelCase<T = any>(obj: any): T {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof FormData || obj instanceof Blob || obj instanceof File) return obj as T;
  if (Array.isArray(obj)) return obj.map(item => toCamelCase(item)) as any;
  if (typeof obj !== 'object') return obj;

  const result: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = toCamelCase(obj[key]);
  }
  return result as T;
}

// Convert camelCase object keys to snake_case
export function toSnakeCase<T = any>(obj: any): T {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof FormData || obj instanceof Blob || obj instanceof File) return obj as T;
  if (Array.isArray(obj)) return obj.map(item => toSnakeCase(item)) as any;
  if (typeof obj !== 'object') return obj;

  const result: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    result[snakeKey] = toSnakeCase(obj[key]);
  }
  return result as T;
}
