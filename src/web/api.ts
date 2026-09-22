// The launch credential stays in the fragment, never in an HTTP URL.
const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';

export async function api<T>(url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach Git Discuss. Check that the local server is still running, then try again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
