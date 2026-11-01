import { lookup } from "node:dns/promises";
import { STATUS_CODES, createServer as createHttpServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server as HttpServer, ServerResponse } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import type { AddressInfo, Server as TcpServer, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { parseIp } from "../../network.js";
import { isPort } from "./config.js";
import type { EgressProxyConfig } from "./config.js";
import { EgressPolicy, PROXY_LOCAL_CIDRS, addressInRanges, normalizeHost, ranges } from "./policy.js";

export interface EgressProxyOptions {
  /** Listen address. Default `"0.0.0.0"`. */
  host?: string;
  /** Resolves a host name to addresses. Default: the system resolver. */
  resolve?: (name: string) => Promise<string[]>;
  /** Destinations always refused. Default `PROXY_LOCAL_CIDRS` (the proxy's own loopback). */
  alwaysDeny?: string[];
  log?: (line: string) => void;
}

export interface RunningEgressProxy {
  /** Port the HTTP proxy listens on (differs from the config when it asked for port 0). */
  port: number;
  /** Listening port of each forward, in config order. */
  forwardPorts: number[];
  close(): Promise<void>;
}

const LOOPBACK_CLIENTS = ["127.0.0.0/8", "::1/128"];
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type Route = { allowed: true; address: string } | { allowed: false; status: 403 | 502; reason: string };

/**
 * Starts the egress proxy that enforces a sandbox's network allowlist. The
 * sandbox reaches the internet only through it, as an HTTP proxy
 * (`HTTP_PROXY` / `HTTPS_PROXY`): plain `http://` requests are forwarded and
 * everything else is tunneled with `CONNECT`, so TLS stays end to end. It
 * also forwards the sandbox's published ports.
 */
export async function startEgressProxy(config: EgressProxyConfig, options: EgressProxyOptions = {}): Promise<RunningEgressProxy> {
  const host = options.host ?? "0.0.0.0";
  const log = options.log ?? (() => undefined);
  const resolve = options.resolve ?? (async (name: string) => (await lookup(name, { all: true })).map((entry) => entry.address));
  const policy = new EgressPolicy(config.policy, { alwaysDeny: options.alwaysDeny ?? PROXY_LOCAL_CIDRS });
  const clients = ranges([...config.clients, ...LOOPBACK_CLIENTS]);
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  /** Decides on a connection to `target:port`; `method` is for the log (`CONNECT`, `GET`, ...). */
  async function route(method: string, target: string, port: number): Promise<Route> {
    const name = normalizeHost(target);
    let addresses = [name];
    if (parseIp(name) === null && policy.needsResolution(name)) {
      try {
        addresses = await resolve(name);
      } catch {
        return { allowed: false, status: 502, reason: `could not resolve ${name}` };
      }
    }
    const decision = policy.decide(name, addresses);
    log(
      decision.allowed
        ? `allow ${method} ${name}:${port} -> ${decision.address}`
        : `deny ${method} ${name}:${port}: ${decision.reason}`,
    );
    return decision.allowed ? decision : { allowed: false, status: 403, reason: decision.reason };
  }

  const proxy = createHttpServer();
  proxy.on("connection", (socket: Socket) => {
    if (!addressInRanges(socket.remoteAddress, clients)) {
      log(`refuse client ${socket.remoteAddress}`);
      socket.destroy();
      return;
    }
    track(socket);
  });
  proxy.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void forwardRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) reply(res, 502, `Proxy error: ${message(error)}`);
      else res.destroy();
    });
  });
  proxy.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void tunnel(req, socket as Socket, head).catch(() => socket.destroy());
  });
  proxy.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
    refuse(socket, 501, "Upgrades over plain HTTP are not supported; use CONNECT");
  });
  proxy.on("clientError", (_error: Error, socket: Duplex) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  async function forwardRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? "";
    if (target.startsWith("/")) {
      if (target === "/healthz") return reply(res, 200, "ok");
      return reply(res, 400, "This is the sandbox egress proxy: send proxy requests (absolute URLs or CONNECT)");
    }
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return reply(res, 400, `Invalid request target ${target}`);
    }
    if (url.protocol !== "http:") {
      return reply(res, 400, `Only http:// URLs can be forwarded; tunnel ${url.protocol} with CONNECT`);
    }
    const port = url.port ? Number(url.port) : 80;
    const decision = await route(req.method ?? "GET", url.hostname, port);
    if (!decision.allowed) return reply(res, decision.status, `Blocked by the sandbox egress proxy: ${decision.reason}`);

    const upstream = httpRequest({
      host: decision.address,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...withoutHopByHop(req.headers), host: url.host },
      agent: false,
      setHost: false,
    });
    upstream.on("response", (response) => {
      const status = response.statusCode ?? 502;
      res.writeHead(status, response.statusMessage || STATUS_CODES[status] || "", withoutHopByHop(response.headers));
      response.pipe(res);
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) reply(res, 502, `Could not reach ${url.host}: ${message(error)}`);
      else res.destroy();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  async function tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const target = parseAuthority(req.url ?? "");
    if (target === null) return refuse(client, 400, `Invalid CONNECT target ${req.url}`);
    const decision = await route("CONNECT", target.host, target.port);
    if (!decision.allowed) return refuse(client, decision.status, `Blocked by the sandbox egress proxy: ${decision.reason}`);
    const upstream = connect({ host: decision.address, port: target.port, allowHalfOpen: true });
    track(upstream);
    const onConnectError = (error: Error) => refuse(client, 502, `Could not reach ${req.url}: ${error.message}`);
    upstream.once("error", onConnectError);
    upstream.once("connect", () => {
      upstream.off("error", onConnectError);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      splice(client, upstream);
    });
    client.once("close", () => upstream.destroy());
  }

  const forwardServers = config.forwards.map((forward) =>
    createTcpServer({ allowHalfOpen: true }, (client) => {
      track(client);
      const upstream = connect({ host: forward.host, port: forward.targetPort, allowHalfOpen: true });
      track(upstream);
      splice(client, upstream);
    }),
  );

  const port = await listen(proxy, config.port, host);
  const forwardPorts: number[] = [];
  for (const [index, server] of forwardServers.entries()) {
    forwardPorts.push(await listen(server, config.forwards[index]!.port, host));
  }

  return {
    port,
    forwardPorts,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, ...forwardServers].map((server) => new Promise((done) => server.close(done))));
    },
  };
}

/** Pipes two sockets into each other, passing half-closes through, until both sides are done. */
function splice(a: Socket, b: Socket): void {
  a.pipe(b);
  b.pipe(a);
  const destroy = () => {
    a.destroy();
    b.destroy();
  };
  a.once("error", destroy);
  b.once("error", destroy);
  a.once("close", () => b.destroy());
  b.once("close", () => a.destroy());
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  return isPort(port) ? { host: match[1]!, port } : null;
}

function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = String(headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !listed.includes(name)) result[name] = value;
  }
  return result;
}

function reply(res: ServerResponse, status: number, body: string): void {
  const text = `${body}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    connection: "close",
  });
  res.end(text);
}

function refuse(socket: Duplex, status: number, body: string): void {
  const reason = { 400: "Bad Request", 403: "Forbidden", 501: "Not Implemented", 502: "Bad Gateway" }[status] ?? "Error";
  const text = `${body}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`,
  );
}

function listen(server: HttpServer | TcpServer, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
