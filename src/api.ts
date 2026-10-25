export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = { ok: boolean }>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new RequestError(data.error || '操作未完成。', response.status);
  return data as T;
}

const pending = new Map<string, string>();
export async function money(path: string, body: Record<string, unknown> = {}) {
  const fingerprint = JSON.stringify([path, body]);
  const operationId = pending.get(fingerprint) || crypto.randomUUID();
  pending.set(fingerprint, operationId);
  try {
    const result = await api(path, { ...body, operationId });
    pending.delete(fingerprint);
    return result;
  } catch (error) {
    // 网络中断时保留编号，下一次同内容提交不会重复扣款。
    if (error instanceof RequestError && error.status < 500) pending.delete(fingerprint);
    throw error;
  }
}

export const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请重试。';
export const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
