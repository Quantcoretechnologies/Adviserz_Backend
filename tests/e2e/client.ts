/**
 * Minimal HTTP client for the end-to-end suite. Responses are parsed loosely
 * (`any`) on purpose: the suite asserts the wire format clients actually see.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ApiResponse {
  status: number;
  json: any;
  headers: Headers;
  setCookies: string[];
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  token?: string;
  headers?: Record<string, string>;
  cookies?: string;
}

export function createClient(apiUrl: string) {
  return async function call(method: string, pathOrUrl: string, options: RequestOptions = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined || options.rawBody !== undefined) headers['content-type'] = 'application/json';
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (options.cookies) headers['cookie'] = options.cookies;

    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${apiUrl}${pathOrUrl}`;
    const response = await fetch(url, {
      method,
      headers,
      body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : null),
    });

    let json: any = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers, setCookies: response.headers.getSetCookie() };
  };
}

/** "name=value; Path=..." list -> "name=value; name2=value2" request header. */
export function toCookieHeader(setCookies: string[]): string {
  return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

export function cookieValue(setCookies: string[], name: string): string | null {
  const cookie = setCookies.find((entry) => entry.startsWith(`${name}=`));
  return cookie ? (cookie.split(';')[0] ?? '').slice(name.length + 1) : null;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
