/**
 * Bridge Workers - Reverse proxy to VPS
 *
 * All requests are forwarded to BRIDGE_ORIGIN.
 * This hides the VPS address from both mobile and PC clients.
 */

interface Env {
  BRIDGE_ORIGIN: string; // e.g. "https://your-vps:3000"
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.BRIDGE_ORIGIN);

    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', url.host);

    const res = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.body,
      // @ts-ignore - duplex needed for streaming request body
      duplex: 'half',
    });

    // Pass through response as-is (including SSE streams)
    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  },
};
