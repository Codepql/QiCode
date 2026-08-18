import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SafeFetchDependencies {
  lookup(hostname: string): Promise<readonly { address: string }[]>;
  fetch(url: URL, init: RequestInit): Promise<Response>;
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  allowLoopback: boolean;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

const DEFAULT_DEPENDENCIES: SafeFetchDependencies = {
  lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  fetch: (url, init) => fetch(url, init),
};

/**
 * 受限文本请求。公网只允许 HTTPS；本地回调必须显式开启 allowLoopback，
 * 且所有解析地址都必须是 loopback。每一次重定向都会重新校验目标。
 */
export async function fetchSafeText(
  source: string,
  options: SafeFetchOptions,
  dependencies: SafeFetchDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let url = new URL(source);
    for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
      await assertSafeUrl(url, options.allowLoopback, dependencies);
      const response = await dependencies.fetch(url, {
        redirect: "manual",
        method: options.method ?? "GET",
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect response did not include a location");
        if (redirects === options.maxRedirects) throw new Error("too many redirects");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`remote server returned HTTP ${response.status}`);
      return readResponseText(response, options.maxResponseBytes);
    }
    throw new Error("too many redirects");
  } catch (error) {
    if (controller.signal.aborted) throw new Error("download timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function assertSafeUrl(
  url: URL,
  allowLoopback: boolean,
  dependencies: SafeFetchDependencies,
): Promise<void> {
  if (url.username !== "" || url.password !== "") throw new Error("URL credentials are not allowed");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only HTTP or HTTPS URLs are allowed");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dependencies.lookup(hostname);
  if (addresses.length === 0) throw new Error("remote URL must resolve to an address");

  if (allowLoopback && addresses.every((entry) => isLoopbackAddress(entry.address))) return;
  if (url.protocol !== "https:") throw new Error("only loopback HTTP URLs are allowed");
  if (addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("remote URL must resolve to public addresses");
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error("remote response exceeds the size limit");
  }
  if (!response.body) throw new Error("remote response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("remote response exceeds the size limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(concatChunks(chunks, size));
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address);
  const words = ipv6Words(address);
  if (words === null) return false;

  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicIpv4(`${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`);
  }

  const first = words[0]!;
  if (first < 0x2000 || first > 0x3fff) return false;
  return !(first === 0x2001 && words[1] === 0x0db8);
}

export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith("127.");
  const words = ipv6Words(address);
  return words !== null && words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [first, second, third] = parts;
  if (first === undefined || second === undefined || third === undefined) return false;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function ipv6Words(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase().split("%", 1)[0]!;
  const ipv4Match = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match !== null) {
    const octets = ipv4Match[2]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return null;
    normalized = `${ipv4Match[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;

  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}
