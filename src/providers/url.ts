import { ProviderResponseError } from "./errors.js";

export function buildProviderUrl(baseUrl: string, resource: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderResponseError("Provider base URL is invalid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderResponseError("Provider base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new ProviderResponseError("Provider base URL must not contain credentials");
  }

  const resourceSegments = splitPath(resource);
  if (resourceSegments.length === 0) {
    throw new ProviderResponseError("Provider resource path must not be empty");
  }

  const baseSegments = splitPath(url.pathname);
  const normalizedBase = endsWithSegments(baseSegments, resourceSegments)
    ? baseSegments.slice(0, -resourceSegments.length)
    : baseSegments;
  if (normalizedBase.at(-1)?.toLowerCase() !== "v1") {
    normalizedBase.push("v1");
  }

  url.pathname = `/${[...normalizedBase, ...resourceSegments]
    .map(encodeURIComponent)
    .join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function splitPath(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new ProviderResponseError("Provider URL contains invalid path encoding");
      }
    });
}

function endsWithSegments(path: string[], suffix: string[]): boolean {
  return suffix.length <= path.length
    && suffix.every(
      (segment, index) => path[path.length - suffix.length + index] === segment,
    );
}
