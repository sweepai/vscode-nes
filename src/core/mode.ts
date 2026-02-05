import {
  DEFAULT_API_ENDPOINT,
  DEFAULT_LOCAL_API_URL,
} from "~/core/constants";

export type SweepMode = "hosted" | "local";

const DEFAULT_LOCAL_COMPLETIONS_PATH = "/v1/completions";

export function resolveApiUrl(mode: SweepMode, localUrl: string): string {
  if (mode !== "local") return DEFAULT_API_ENDPOINT;
  const trimmed = localUrl.trim();
  const base = trimmed.length > 0 ? trimmed : DEFAULT_LOCAL_API_URL;
  try {
    const url = new URL(base);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname === "" || pathname === "/") {
      url.pathname = DEFAULT_LOCAL_COMPLETIONS_PATH;
    } else {
      url.pathname = pathname;
    }
    return url.toString();
  } catch {
    return base.replace(/\/+$/, "");
  }
}

export function shouldRequireApiKey(mode: SweepMode): boolean {
  return mode !== "local";
}
