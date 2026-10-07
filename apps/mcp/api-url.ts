export function agentApiUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Set BRAIN_API_URL to the local API or a trusted HTTPS origin.",
    );
  }
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    !!url.port;
  if (
    (!local && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "BRAIN_API_URL must be a loopback HTTP or trusted HTTPS origin without credentials or a path.",
    );
  return url.origin;
}
