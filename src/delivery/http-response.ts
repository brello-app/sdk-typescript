const MAX_RESPONSE_BYTES = 64_000;

/** Release an unused response body without delaying the delivery worker. */
export function cancelBody(body: { cancel(): Promise<void> } | null): void {
  // Do not wait for a remote or custom stream to acknowledge cancellation.
  try { void body?.cancel().catch(() => {}); } catch { /* Best effort. */ }
}

/**
 * Read only bounded ingestion responses. Count bytes before decoding them and
 * carry partial UTF-8 characters across chunks. Always release the reader,
 * including on an oversized response, aborted request, or invalid JSON.
 */
export async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let json = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(json + decoder.decode());
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return undefined;
      json += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    cancelBody(reader);
    reader.releaseLock();
  }
}
