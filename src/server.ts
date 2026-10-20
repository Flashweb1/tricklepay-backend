import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { checkHealth } from "./db.js";
import { logger } from "./logger.js";
import { httpRequestDuration, httpRequestsTotal } from "./metrics.js";
import { getIndexerPosition } from "./repositories/indexer-state.js";
import { serviceVersion } from "./version.js";
import {
  apiErrorSchema,
  indexerStatusSchema,
  streamListResponseSchema,
  streamSummaryResponseSchema,
  streamViewSchema,
} from "./schema.js";
import type { Config } from "./config.js";
import { isTrustedProxyAddress, parseTrustedProxies } from "./proxy.js";

// ---------------------------------------------------------------------------
// Request ids.
//
// Every request gets an id that appears as the `reqId` field in Fastify's
// structured request logs and is echoed back in the `x-request-id` response
// header and error bodies, so a client report can be matched to its log lines.
// A caller may supply its own id through `x-request-id`, but arbitrary header
// values are not trusted: an id is forwarded only when it is short and made of
// safe characters; anything else (or nothing) yields a fresh UUID.
// ---------------------------------------------------------------------------
export const REQUEST_ID_HEADER = "x-request-id";

const MAX_REQUEST_ID_LENGTH = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_REQUEST_ID_LENGTH) return undefined;
  return REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Error redaction (#74).
//
// Raw RPC or database errors can carry connection strings, SQL fragments, or
// stack traces that must never reach a client. Outgoing messages are stripped
// of credential-bearing URLs and collapsed to their first line; the original
// error is preserved in the structured request log together with the request
// id for diagnosis.
// ---------------------------------------------------------------------------

/** Matches URLs with an authority that can embed credentials, e.g. postgres://user:pass@host/db */
const CREDENTIAL_URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@[^\s]*/g;

export function redactErrorMessage(message: string): string {
  // Keep only the first line so stack traces and multi-line driver errors are
  // never echoed back to clients.
  const firstLine = message.split("\n")[0].trim();
  return firstLine.replace(CREDENTIAL_URL_PATTERN, "[redacted]");
}

// ---------------------------------------------------------------------------
// Structured error codes (#73).
//
// Every API failure carries a stable, machine-readable `code` alongside the
// existing message and status, so clients can branch on the category without
// parsing human-readable text.
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "REQUEST_ERROR"
  | "INTERNAL_SERVER_ERROR";

export function errorCodeForStatus(statusCode: number): ApiErrorCode {
  if (statusCode === 400) return "VALIDATION_ERROR";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode >= 500) return "INTERNAL_SERVER_ERROR";
  return "REQUEST_ERROR";
}

// Builds the Fastify instance with the shared logger, CORS, the OpenAPI
// plugin, and the routes that do not depend on external services. Route groups
// that need the database are registered by the caller during bootstrap.
//
// @fastify/swagger MUST be registered before any routes so that it can observe
// every route schema. The shared JSON Schema definitions ($id-bearing objects)
// are added to the Fastify schema store here so that routes may reference them
// with $ref and the plugin emits them as reusable OpenAPI components.
export async function buildServer(config?: Config): Promise<FastifyInstance> {
  const trustedProxies = config?.trustedProxies ?? [];
  const app = Fastify({
    // Fastify types its logger as FastifyBaseLogger; the pino instance
    // satisfies that interface at runtime.
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: config?.bodyLimit,
    // Forwarded headers (X-Forwarded-For, X-Forwarded-Proto) are honored only
    // when the direct connection peer is an explicitly trusted proxy (#75).
    // Without configuration the socket address is used as-is, so a direct
    // client cannot spoof the recorded client address in logs or request
    // metadata.
    trustProxy:
      trustedProxies.length > 0
        ? (address: string) => isTrustedProxyAddress(address, trustedProxies)
        : false,
    // Derive the request id from a client-supplied header when it is safe,
    // otherwise generate one. Fastify binds the id to the per-request child
    // logger, so it lands in every structured request log line as `reqId`.
    genReqId: (req) =>
      sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID(),
    // Parsing only: query-string validation must not throw from here. This
    // callback runs during routing, before any hook, so a throw would escape
    // Fastify's error handler and crash the process. Length and duplicate
    // checks live in the onRequest hook below instead (#519).
    querystringParser: (str: string) => {
      const params = new URLSearchParams(str);
      const result: Record<string, string> = {};
      params.forEach((value, key) => {
        result[key] = value;
      });
      return result;
    },
  });

  // Record every response against the Prometheus counters. `routeOptions.url`
  // is the route pattern ("/streams/:id") rather than the resolved path, which
  // keeps the label set bounded no matter how many distinct ids are requested.
  // Unmatched requests fall back to "unknown" for the same reason.
  app.addHook("onResponse", async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions?.url ?? "unknown",
      status: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime);
  });

  // Echo the request id on every response so clients can quote it back. Set
  // before routing, so even requests that fail early carry the header.
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Query-string hardening (#519). Fastify parses the query string while
  // routing, before any hook, so this runs after parsing but still before the
  // route handler and before any database access.
  //
  // Repeating a parameter is rejected instead of silently keeping the last
  // value, which would hide client mistakes and is a known parameter-pollution
  // footgun. The parser itself must never throw: it runs during routing, where
  // an exception bypasses Fastify's error handler and crashes the process.
  app.addHook("onRequest", async (request, reply) => {
    const rawUrl = request.raw.url ?? "";
    const queryStart = rawUrl.indexOf("?");
    if (queryStart === -1) return;
    const query = rawUrl.slice(queryStart + 1);

    if (config?.queryStringLimit && query.length > config.queryStringLimit) {
      return reply.code(400).send({
        code: errorCodeForStatus(400),
        error: "query string too long",
        requestId: request.id,
      });
    }

    const seen = new Set<string>();
    for (const key of new URLSearchParams(query).keys()) {
      if (seen.has(key)) {
        return reply.code(400).send({
          code: errorCodeForStatus(400),
          error: `repeated query parameter: ${key}`,
          requestId: request.id,
        });
      }
      seen.add(key);
    }
  });

  // Attach the request id to error bodies so an error a client saw can be
  // traced to its log lines. Status codes are preserved and each failure
  // carries a stable machine-readable code (#73). Outgoing messages are
  // redacted so connection strings, SQL fragments, or stack traces never
  // reach the client (#74); the original error is logged server-side with
  // the request id for diagnosis.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const statusCode = typeof err.statusCode === "number" && err.statusCode >= 400
      ? err.statusCode
      : 500;
    if (statusCode >= 500) {
      request.log.error({ err }, "request failed");
    }
    const message =
      statusCode >= 500
        ? "internal server error"
        : redactErrorMessage(err.message);
    void reply.status(statusCode).send({
      code: errorCodeForStatus(statusCode),
      error: message,
      requestId: request.id,
    });
  });

  // Unmatched routes bypass the error handler, so they get their own handler —
  // with the request id attached like every other error response.
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      code: errorCodeForStatus(404),
      error: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
  });

  // The web client fetches this API from the browser, so it is always a
  // cross-origin caller once the two run on separate ports or hosts. The data
  // served here is public and read-only, so any origin is reflected by
  // default; set CORS_ORIGIN to pin deployments to a known frontend. Not
  // awaited because Fastify defers plugin loading until ready/listen, which
  // keeps this builder synchronous for its callers.
  void app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? true,
  });

  // Security headers (#520). This is a JSON API, but the interactive docs at
  // /docs are served from the same origin, so the policy has to be strict for
  // API responses while still allowing Swagger UI to load its own assets:
  // its scripts are external files under /docs/static and it styles the page
  // with inline style attributes, hence 'self' for scripts and 'unsafe-inline'
  // for styles only. `upgrade-insecure-requests` is deliberately not set: the
  // docs must keep working when the API is reached over plain HTTP in local
  // development or through a TLS-terminating proxy. HSTS still applies when
  // the request is actually served over HTTPS.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "https:", "'unsafe-inline'"],
        // helmet merges this with its defaults; null removes the default
        // directive for the reason described above.
        upgradeInsecureRequests: null,
      },
    },
    // The API is deliberately callable cross-origin (see CORS above), so the
    // same-origin default would contradict that policy for non-CORS consumers.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer" },
  });

  // Register shared schemas so routes can reference them with { $ref: "$id" }.
  // @fastify/swagger will emit them as named components in the spec.
  app.addSchema(streamViewSchema);
  app.addSchema(streamListResponseSchema);
  app.addSchema(streamSummaryResponseSchema);
  app.addSchema(indexerStatusSchema);
  app.addSchema(apiErrorSchema);

  // Generate the OpenAPI 3.0 spec from route schemas automatically.
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "TricklePay API",
        description:
          "Indexer and read API for TricklePay token streams on Stellar. " +
          "The indexer mirrors on-chain stream state into Postgres and this API " +
          "serves it, computing live vesting figures server-side.",
        version: "0.1.0",
        license: {
          name: "MIT",
          url: "https://opensource.org/licenses/MIT",
        },
      },
      tags: [
        {
          name: "streams",
          description: "Token stream read endpoints.",
        },
        {
          name: "indexer",
          description: "Indexer health and progress.",
        },
      ],
      components: {
        // Schemas are pulled from app.addSchema calls above; no need to list
        // them here — @fastify/swagger discovers them automatically.
      },
    },
    // Without this, every shared schema is emitted under a positional name
    // ("def-0", "def-1", ...) and the $ref targets in the routes point at
    // those. Naming each component after its $id is what makes the spec
    // readable and keeps generated clients stable as schemas are added.
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return (json.$id as string | undefined) ?? `def-${i}`;
      },
    },
  });

  // Serve the interactive Swagger UI at /docs and the raw spec at /docs/json
  // and /docs/yaml (these paths are the @fastify/swagger-ui defaults).
  //
  // ENABLE_DOCS_UI=false (#521) removes the UI plugin entirely, which also
  // removes its HTML page and static assets. The machine-readable document is
  // still served at the same paths, generated on demand from the route
  // schemas, so spec consumers are unaffected. `hide: true` keeps these two
  // helper routes out of the generated document itself.
  if (config?.enableDocsUi ?? true) {
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: {
        // Open the models panel by default so the schema components are visible.
        defaultModelsExpandDepth: 2,
        defaultModelExpandDepth: 3,
      },
    });
  } else {
    app.get("/docs/json", { schema: { hide: true } }, async (_request, reply) => {
      return reply
        .type("application/json; charset=utf-8")
        .send(app.swagger());
    });

    app.get("/docs/yaml", { schema: { hide: true } }, async (_request, reply) => {
      return reply
        .type("application/yaml; charset=utf-8")
        .send(app.swagger({ yaml: true }));
    });
  }

  app.get("/health", {
    schema: {
      summary: "Liveness check",
      description:
        "Returns 200 when the server is up, along with the running service version. No database read is performed.",
      tags: ["indexer"],
      response: {
        200: {
          type: "object",
          required: ["status", "version"],
          properties: {
            status: { type: "string", enum: ["ok"] },
            version: {
              type: "string",
              description:
                "Service version from the package manifest, for distinguishing binaries during rolling releases.",
            },
          },
        },
      },
    },
  }, async () => {
    return { status: "ok", version: serviceVersion };
  });

  app.get("/ready", {
    schema: {
      summary: "Readiness check",
      description:
        "Verifies database connectivity and reports indexer lag. Returns 503 when a dependency is unavailable.",
      tags: ["indexer"],
      response: {
        200: {
          type: "object",
          required: ["status", "database", "indexer"],
          properties: {
            status: { type: "string", enum: ["ready"] },
            database: { type: "string", enum: ["up"] },
            indexer: {
              type: "object",
              required: ["lagLedgers"],
              properties: {
                lagLedgers: { type: ["integer", "null"] },
              },
            },
          },
        },
        503: {
          type: "object",
          required: ["status", "database"],
          properties: {
            status: { type: "string", enum: ["not_ready"] },
            database: { type: "string", enum: ["down"] },
            error: { type: "string" },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const db = await checkHealth();
    if (db.status === "down") {
      void reply.status(503);
      return { status: "not_ready", database: "down", error: db.error };
    }

    const position = await getIndexerPosition();
    const lagLedgers = position
      ? Math.max(0, position.chainLedger - position.lastLedger)
      : null;

    return { status: "ready", database: "up", indexer: { lagLedgers } };
  });

  return app;
}
