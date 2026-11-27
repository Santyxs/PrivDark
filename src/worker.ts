/// <reference types="@cloudflare/workers-types" />

/**
 * PrivDark API Worker.
 * Receives an image and prompt, submits one Gradio job and streams its result.
 * Generation requests are never retried automatically to protect GPU quota.
 */

export interface Env {
  readonly ALLOWED_ORIGINS: string;
  readonly HF_SPACE_BASE: string;
  readonly HF_FN_NAME: string;
  readonly HF_TOKEN?: string;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 500;
const MAX_UPSTREAM_DETAIL_LENGTH = 700;
const DEFAULT_DURATION = 5;
const MIN_DURATION = 1;
const MAX_DURATION = 10;
const DEFAULT_STEPS = 3;
const MIN_STEPS = 3;
const MAX_STEPS = 8;

const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, " +
  "最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, " +
  "画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, " +
  "杂乱的背景, 三条腿, 背景人很多, 倒着走";

const encoder = new TextEncoder();

interface ParsedSseEvent {
  readonly event: string;
  readonly data: string;
}

class HuggingFaceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = "HuggingFaceError";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin, env);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(jsonResponse({ ok: true, service: "privdark-api" }), origin, env);
    }

    if (request.method === "POST" && url.pathname === "/generate") {
      const allowedOrigins = (env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      if (!origin || !allowedOrigins.includes(origin)) {
        return withCors(jsonResponse({ error: "Origen no autorizado. Accede desde PrivDark." }, 403), origin, env);
      }
      try {
        return withCors(await handleGenerate(request, env), origin, env);
      } catch (error: unknown) {
        const message = error instanceof Error
          ? error.message
          : "Error inesperado al generar el vídeo. Inténtalo de nuevo.";
        const status = error instanceof HuggingFaceError ? error.statusCode : 502;
        return withCors(jsonResponse({ error: message }, status), origin, env);
      }
    }

    return withCors(
      jsonResponse({ error: "Ruta no encontrada. Usa POST /generate o GET /health." }, 404),
      origin,
      env,
    );
  },
} satisfies ExportedHandler<Env>;

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  const spaceBase = getSpaceBase(env);
  const functionName = env.HF_FN_NAME?.trim();
  if (!functionName) throw new Error("Falta configurar HF_FN_NAME en el Worker.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse(
      { error: "La petición debe enviarse como multipart/form-data (imagen + parámetros)." },
      400,
    );
  }

  const image = form.get("image");
  if (!(image instanceof File)) {
    return jsonResponse({ error: "Falta la imagen. Sube un archivo PNG, JPG o WEBP." }, 400);
  }
  if (image.size === 0) {
    return jsonResponse({ error: "El archivo de imagen está vacío. Elige otra imagen." }, 400);
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return jsonResponse({ error: "La imagen pesa más de 8 MB. Elige una más ligera." }, 413);
  }
  if (!(await isSupportedImage(image))) {
    return jsonResponse({ error: "Formato de imagen no válido. Solo se admiten PNG, JPG y WEBP." }, 415);
  }

  const rawParams = form.get("params");
  const parsedParams = typeof rawParams === "string" ? safeJsonParse(rawParams) : null;
  const params = isRecord(parsedParams) ? parsedParams : {};
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";

  if (!prompt) {
    return jsonResponse({ error: "Falta el prompt. Describe el movimiento que debe hacer el vídeo." }, 400);
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse(
      { error: `El prompt es demasiado largo (máximo ${MAX_PROMPT_LENGTH} caracteres). Acórtalo e inténtalo de nuevo.` },
      400,
    );
  }

  const steps = clampInt(params.steps, DEFAULT_STEPS, MIN_STEPS, MAX_STEPS);
  const duration = clampFloat(params.duration, DEFAULT_DURATION, MIN_DURATION, MAX_DURATION);

  // Do not retry: a duplicate submission can consume additional GPU quota.
  const imagePath = await uploadImageToSpace(image, spaceBase, env);
  const eventId = await submitJob(imagePath, image.name, prompt, steps, duration, spaceBase, functionName, env);
  const upstream = await fetch(
    `${spaceBase}/gradio_api/call/${encodeURIComponent(functionName)}/${encodeURIComponent(eventId)}`,
    { headers: hfHeaders(env, { Accept: "text/event-stream" }) },
  );

  if (!upstream.ok || !upstream.body) {
    const detail = await readResponseDetail(upstream);
    throw new HuggingFaceError(
      buildHuggingFaceError("recibir el vídeo", detail, upstream.status),
      clientStatus(upstream.status),
    );
  }

  const contentType = upstream.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const detail = await readResponseDetail(upstream);
    throw new HuggingFaceError(
      buildHuggingFaceError(
        "recibir el vídeo",
        detail || `Hugging Face devolvió un tipo de contenido inesperado (${contentType || "desconocido"}).`,
        upstream.status,
      ),
      502,
    );
  }

  return new Response(forwardSseWithReadableErrors(upstream.body), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function getSpaceBase(env: Env): string {
  const raw = env.HF_SPACE_BASE?.trim();
  if (!raw) throw new Error("Falta configurar HF_SPACE_BASE en el Worker.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("HF_SPACE_BASE no contiene una URL válida.");
  }
  if (url.protocol !== "https:") {
    throw new Error("HF_SPACE_BASE debe utilizar HTTPS.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

async function uploadImageToSpace(file: File, spaceBase: string, env: Env): Promise<string> {
  const form = new FormData();
  form.append("files", file, safeFileName(file.name));

  const response = await fetch(`${spaceBase}/gradio_api/upload`, {
    method: "POST",
    headers: hfHeaders(env),
    body: form,
  });

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new HuggingFaceError(
      buildHuggingFaceError("subir la imagen", detail, response.status),
      clientStatus(response.status),
    );
  }

  let paths: unknown;
  try {
    paths = await response.json();
  } catch {
    throw new HuggingFaceError("Hugging Face recibió la imagen, pero devolvió una respuesta que no es JSON válido.");
  }

  if (!Array.isArray(paths) || typeof paths[0] !== "string" || !paths[0]) {
    throw new HuggingFaceError(
      "Hugging Face no devolvió una ruta de imagen válida tras la subida. No se ha iniciado ninguna generación.",
    );
  }
  return paths[0];
}

async function submitJob(
  imagePath: string,
  originalName: string,
  prompt: string,
  steps: number,
  duration: number,
  spaceBase: string,
  functionName: string,
  env: Env,
): Promise<string> {
  const encodedImagePath = imagePath.split("/").map(encodeURIComponent).join("/");
  const inputImage = {
    path: imagePath,
    url: `${spaceBase}/gradio_api/file=${encodedImagePath}`,
    orig_name: safeFileName(originalName),
    size: null,
    mime_type: null,
    meta: { _type: "gradio.FileData" },
  };

  const data = [
    inputImage,
    null,
    prompt,
    steps,
    DEFAULT_NEGATIVE_PROMPT,
    duration,
    1,
    1,
    42,
    true,
    6,
    "UniPCMultistep",
    3.0,
    16,
    false,
    true,
  ];

  const response = await fetch(`${spaceBase}/gradio_api/call/${encodeURIComponent(functionName)}`, {
    method: "POST",
    headers: hfHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ data }),
  });

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new HuggingFaceError(
      buildHuggingFaceError("iniciar la generación", detail, response.status),
      clientStatus(response.status),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HuggingFaceError(
      "Hugging Face aceptó la petición, pero no devolvió un identificador de generación válido.",
    );
  }

  if (!isRecord(payload) || typeof payload.event_id !== "string" || !payload.event_id) {
    throw new HuggingFaceError(
      "Hugging Face no devolvió un ID de trabajo. El Space puede estar ocupado o no disponible. No se ha repetido la petición.",
    );
  }
  return payload.event_id;
}

function forwardSseWithReadableErrors(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let released = false;

  const releaseReader = (): void => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // The stream may already have been cancelled by the client.
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              const finalEvent = parseSseEvent(buffer);
              const output = finalEvent.event === "error"
                ? encodeSseError(buildHuggingFaceError("generar el vídeo", extractSseError(finalEvent.data)))
                : `${buffer}\n\n`;
              controller.enqueue(encoder.encode(output));
            }
            controller.close();
            releaseReader();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          let emitted = false;

          while (true) {
            const separator = /\r?\n\r?\n/.exec(buffer);
            if (!separator || separator.index === undefined) break;

            const block = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            if (!block.trim()) continue;

            const parsed = parseSseEvent(block);
            if (parsed.event === "error") {
              const message = buildHuggingFaceError("generar el vídeo", extractSseError(parsed.data));
              controller.enqueue(encoder.encode(encodeSseError(message)));
              await reader.cancel().catch(() => undefined);
              controller.close();
              releaseReader();
              return;
            }

            controller.enqueue(encoder.encode(`${block}\n\n`));
            emitted = true;
          }

          if (emitted) return;
        }
      } catch {
        const message =
          "Se interrumpió la conexión con Hugging Face mientras se generaba el vídeo. Comprueba el estado del Space y vuelve a intentarlo cuando esté disponible. No se ha enviado un segundo trabajo automáticamente.";
        try {
          controller.enqueue(encoder.encode(encodeSseError(message)));
          controller.close();
        } catch {
          // The client may have cancelled the downstream stream.
        }
        await reader.cancel().catch(() => undefined);
        releaseReader();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      releaseReader();
    },
  });
}

function parseSseEvent(block: string): ParsedSseEvent {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: data.join("\n") };
}

function extractSseError(raw: string): string {
  const value = raw.trim();
  if (!value || value === "null" || value === "undefined") return "";

  const parsed = safeJsonParse(value);
  if (typeof parsed === "string") return truncateDetail(parsed);
  if (isRecord(parsed)) {
    for (const key of ["message", "error", "detail", "description", "title"]) {
      const candidate = parsed[key];
      if (typeof candidate === "string" && candidate.trim()) return truncateDetail(candidate);
    }
  }
  return truncateDetail(value);
}

function encodeSseError(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ message })}\n\n`;
}

function buildHuggingFaceError(action: string, detail = "", status?: number): string {
  const cleanDetail = truncateDetail(detail);
  const suffix = cleanDetail ? ` Detalle de Hugging Face: ${cleanDetail}` : "";

  if (status === 429 || isQuotaError(cleanDetail)) {
    return (
      "Hugging Face ha alcanzado el límite de uso de GPU o la cuota temporal de este Space. " +
      "No se ha repetido la generación para evitar consumir más cuota. Espera a que se restablezca el límite." +
      suffix
    );
  }
  if (status === 401 || status === 403) {
    return (
      `Hugging Face no ha autorizado la operación al ${action}. Comprueba que el Space sea público y que HF_TOKEN, si lo utilizas, sea válido.` +
      suffix
    );
  }
  if (cleanDetail) return `Hugging Face no ha podido ${action}.${suffix}`;

  return (
    `Hugging Face ha devuelto un error sin detalles al ${action} (Gradio puede haber enviado data:null). ` +
    "El Space puede haber fallado durante la ejecución, no tener GPU disponible o haber alcanzado su cuota. " +
    "No se ha enviado otro trabajo automáticamente. Comprueba el estado y la cuota del Space antes de reintentar."
  );
}

function isQuotaError(value: string): boolean {
  return /(?:quota|daily\s+limit|24\s*(?:h|hours?)|24-hour|rate.?limit|too many requests|zero.?gpu|gpu\s*(?:time|quota|limit)|compute\s*(?:time|quota)|exceeded.{0,40}(?:limit|quota)|limit.{0,40}(?:exceeded|quota|hours?))/i.test(value);
}

function clientStatus(upstreamStatus: number): number {
  if (upstreamStatus === 429) return 429;
  if (upstreamStatus === 503 || upstreamStatus === 504) return 503;
  return 502;
}

function hfHeaders(env: Env, initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  const token = env.HF_TOKEN?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function withCors(response: Response, origin: string, env: Env): Response {
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim());
  const headers = new Headers(response.headers);

  if (origin) headers.set("Vary", "Origin");
  if (origin && allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function isSupportedImage(file: File): Promise<boolean> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isPng = header.length >= 8 &&
    header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47 &&
    header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a;
  const isJpeg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isWebp = header.length >= 12 &&
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
    header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;
  return isPng || isJpeg || isWebp;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "privdark-image.png";
}

async function readResponseDetail(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;
  const maxBytes = 8 * 1024;
  try {
    while (bytesRead < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      const chunk = value.subarray(0, remaining);
      bytesRead += chunk.byteLength;
      body += decoder.decode(chunk, { stream: bytesRead < maxBytes });
      if (value.byteLength > remaining) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    body += decoder.decode();
  } catch {
    // Error details are best-effort; do not mask the upstream HTTP error.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released.
    }
  }
  if (!body) return "";

  const compact = body.replace(/\s+/g, " ").trim();
  const parsed = safeJsonParse(compact);
  if (isRecord(parsed)) {
    for (const key of ["error", "message", "detail", "reason"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return truncateDetail(value);
    }
  }
  return truncateDetail(compact);
}

function truncateDetail(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > MAX_UPSTREAM_DETAIL_LENGTH
    ? `${compact.slice(0, MAX_UPSTREAM_DETAIL_LENGTH)}…`
    : compact;
}

function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function clampFloat(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value * 10) / 10;
  return Math.max(minimum, Math.min(maximum, rounded));
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
