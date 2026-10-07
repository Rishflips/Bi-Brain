// The TLS proxy must preserve Host. Forwarded headers never grant access.
export function deploymentPolicy(publicOrigin?: string, port = 4317) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("BRAIN_PORT must be an integer between 1 and 65535.");
  let remote: URL | undefined;
  if (publicOrigin !== undefined) {
    try {
      remote = new URL(publicOrigin);
    } catch {
      throw new Error("BRAIN_PUBLIC_ORIGIN must be one HTTPS origin.");
    }
    if (
      remote.protocol !== "https:" ||
      remote.username ||
      remote.password ||
      remote.pathname !== "/" ||
      remote.search ||
      remote.hash ||
      ![remote.origin, remote.origin + "/"].includes(publicOrigin)
    )
      throw new Error(
        "BRAIN_PUBLIC_ORIGIN must be one HTTPS origin without credentials or a path.",
      );
  }
  const localHost = (host: string) => {
    const match = /^(?:127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/.exec(host);
    return (
      !!match &&
      (!match[1] || (Number(match[1]) > 0 && Number(match[1]) <= 65535))
    );
  };
  const localOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  return {
    secure: !!remote,
    origin: remote?.origin,
    allowsHost: (host: string, path: string) =>
      remote
        ? host === remote.host ||
          (path === "/api/v1/health/live" && localHost(host))
        : localHost(host),
    allowsOrigin: (origin: string | undefined) =>
      origin === undefined ||
      (remote ? origin === remote.origin : localOrigins.has(origin)),
  };
}
