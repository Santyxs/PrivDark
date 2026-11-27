/**
 * PrivDark API Worker.
 *
 * Receives an image and a motion prompt, submits the job to the public
 * Hugging Face Gradio Space, and forwards its SSE response to the browser.
 * Gradio error events are normalized so the frontend never displays "null"
 * when the upstream Space returns an empty error payload.
 *
 * The optional HF_TOKEN is stored as a Worker secret and is never exposed
 * in the static frontend bundle. Generation requests are never retried
 * automatically, avoiding accidental consumption of additional GPU quota.
 */

export interface Env {
  readonly ALLOWED_ORIGINS: string;
  readonly HF_SPACE_BASE: string;
  readonly HF_FN_NAME: string;
  readonly HF_TOKEN?: string;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 500;
const DEFAULT_DURATION = 5;
const MIN_DURATION = 1;
const MAX_DURATION = 10;
const DEFAULT_STEPS = 3;
const MIN_STEPS = 3;
const MAX_STEPS = 8;
const MAX_UPSTREAM_DETAIL_LENGTH = 700;

const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, " +
  "最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, " +
  "画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, " +
  "杂乱的背景, 三条腿, 背景人很多, 倒着走";

const encoder = new TextEncoder();

interface UserParams {
  prompt?: string;
  steps?: number;
  duration?: number;
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

class HuggingFaceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "HuggingFaceError";
    this.statusCode = statusCode;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") ?? "";

    if (req.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin, env);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return withCors(jsonResponse({ ok: true, service: "privdark-api" }), origin, env);
    }

    if (req.method === "POST" && url.pathname === "/generate") {
      try {
        const response = await handleGenerate(req, env);
        return withCors(response, origin, env);
      } catch (error: unknown) {
        const message =
          error instanceof Error
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

async function handleGenerate(req: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse(
      { error: "La petición debe enviarse como multipart/form-data (imagen + parámetros)." },
      400,
    );
  }

  const imagePart = form.get("image");
  const paramsRaw = form.get("params");

  if (!(imagePart instanceof File)) {
    return jsonResponse({ error: "Falta la imagen. Sube un archivo PNG, JPG o WEBP." }, 400);
  }
  if (imagePart.size === 0) {
    return jsonResponse(
      { error: "El archivo de imagen está vacío (0 bytes). Elige otra imagen." },
      400,
    );
  }
  if (imagePart.size > MAX_IMAGE_BYTES) {
    return jsonResponse(
      { error: "La imagen pesa más de 8 MB. Comprime o elige una más ligera." },
      413,
    );
  }
  if (!isSupportedImage(imagePart)) {
    return jsonResponse(
      { error: "Formato de imagen no válido. Solo se admiten PNG, JPG y WEBP." },
      415,
    );
  }

  const parsed = typeof paramsRaw === "string" ? safeJsonParse(paramsRaw) : null;
  const params: UserParams = isRecord(parsed) ? (parsed as UserParams) : {};
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";

  if (!prompt) {
    return jsonResponse(
      { error: "Falta el prompt. Describe el movimiento que debe hacer el vídeo." },
      400,
    );
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse(
      {
        error: `El prompt es demasiado largo (máximo ${MAX_PROMPT_LENGTH} caracteres). Acórtalo e inténtalo de nuevo.`,
      },
      400,
    );
  }

  const steps = clampInt(params.steps ?? DEFAULT_STEPS, MIN_STEPS, MAX_STEPS);
  const duration = clampFloat(params.duration ?? DEFAULT_DURATION, MIN_DURATION, MAX_DURATION, 1);

  // Deliberately no retry: a second submission may consume more GPU quota.
  const imagePath = await uploadImageToSpace(imagePart, env);
  const eventId = await submitJob(imagePath, imagePart.name, prompt, steps, duration, env);

  const upstream = await fetch(
    `${env.HF_SPACE_BASE}/gradio_api/call/${env.HF_FN_NAME}/${encodeURIComponent(eventId)}`,
    {
      method: "GET",
      headers: hfHeaders(env, { Accept: "text/event-stream" }),
    },
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
    },
  });
}

async function uploadImageToSpace(file: File, env: Env): Promise<string> {
  const form = new FormData();
  form.append("files", file, safeFileName(file.name));

  const response = await fetch(`${env.HF_SPACE_BASE}/gradio_api/upload`, {
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
    throw new HuggingFaceError(
      "Hugging Face recibió la imagen, pero devolvió una respuesta que no es JSON válido.",
    );
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
  env: Env,
): Promise<string> {
  const inputImage = {
    path: imagePath,
    url: `${env.HF_SPACE_BASE}/gradio_api/file=${imagePath}`,
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

  const response = await fetch(`${env.HF_SPACE_BASE}/gradio_api/call/${env.HF_FN_NAME}`, {
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

/**
 * Reads Gradio's SSE stream one event at a time. Normal events are forwarded
 * unchanged. An `event: error` is rewritten with a useful JSON message so the
 * existing frontend can display it instead of the literal text `null`.
 */
function forwardSseWithReadableErrors(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let readerReleased = false;

  const releaseReader = (): void => {
    if (readerReleased) return;
    readerReleased = true;
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
              const finalEvent = transformSseBlock(buffer);
              controller.enqueue(encoder.encode(finalEvent));
            }
            controller.close();
            releaseReader();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const separator = /\r?\n\r?\n/.exec(buffer);
            if (!separator || separator.index === undefined) break;

            const block = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);

            if (!block.trim()) continue;

            const parsed = parseSseEvent(block);
            if (parsed.event === "error") {
              const message = buildHuggingFaceError(
                "generar el vídeo",
                extractSseError(parsed.data),
              );
              controller.enqueue(encoder.encode(encodeSseError(message)));
              await reader.cancel().catch(() => undefined);
              controller.close();
              releaseReader();
              return;
            }

            controller.enqueue(encoder.encode(`${block}\n\n`));
          }

          // Return after each network chunk so the downstream can consume it.
          if (buffer.length > 0 || value.byteLength > 0) return;
        }
      } catch {
        const message =
          "Se interrumpió la conexión con Hugging Face mientras se generaba el vídeo. Comprueba el estado del Space y vuelve a intentarlo cuando esté disponible. No se ha enviado un segundo trabajo automáticamente.";
        try {
          controller.enqueue(encoder.encode(encodeSseError(message)));
          controller.close();
        } catch {
          controller.error(new Error(message));
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

function transformSseBlock(block: string): string {
  const parsed = parseSseEvent(block);
  if (parsed.event !== "error") return `${block}\n\n`;

  const message = buildHuggingFaceError("generar el vídeo", extractSseError(parsed.data));
  return encodeSseError(message);
}

function parseSseEvent(block: string): ParsedSseEvent {
  let event = "message";
  const data: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
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
      if (typeof candidate === "string" && candidate.trim()) {
        return truncateDetail(candidate);
      }
    }
  }

  return truncateDetail(value);
}

function encodeSseError(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ message })}\n\n`;
}

function buildHuggingFaceError(action: string, detail = "", status?: number): string {
  const cleanDetail = detail.trim();
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

  if (cleanDetail) {
    return `Hugging Face no ha podido ${action}.${suffix}`;
  }

  return (
    `Hugging Face ha devuelto un error sin detalles al ${action} (Gradio puede haber enviado data:null). ` +
    "El Space puede haber fallado durante la ejecución, no tener GPU disponible o haber alcanzado su cuota. " +
    "No se ha enviado otro trabajo automáticamente. Comprueba el estado y la cuota del Space antes de reintentar."
  );
}

function isQuotaError(value: string): boolean {
  return /(?:quota|daily\s+limit|24\s*(?:h|hours?)|24-hour|rate.?limit|too many requests|zero.?gpu|gpu\s*(?:time|quota|limit)|compute\s*(?:time|quota)|exceeded.{0,40}(?:limit|quota)|limit.{0,40}(?:exceeded|quota|hours?))/i.test(
    value,
  );
}

function clientStatus(upstreamStatus: number): number {
  if (upstreamStatus === 429) return 429;
  if (upstreamStatus === 503 || upstreamStatus === 504) return 503;
  return 502;
}

function hfHeaders(env: Env, initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  if (env.HF_TOKEN?.trim()) {
    headers.set("Authorization", `Bearer ${env.HF_TOKEN.trim()}`);
  }
  return headers;
}

function withCors(response: Response, origin: string, env: Env): Response {
  const allowedOrigins = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const headers = new Headers(response.headers);

  if (origin && allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
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

function isSupportedImage(file: File): boolean {
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (allowedTypes.has(file.type.toLowerCase())) return true;
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return cleaned || "privdark-image.png";
}

async function readResponseDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";

  const compact = text.replace(/\s+/g, " ").trim();
  const parsed = safeJsonParse(compact);
  if (isRecord(parsed)) {
    for (const key of ["error", "message", "detail", "reason"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return truncateDetail(value);
      }
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

function clampInt(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function clampFloat(value: number, minimum: number, maximum: number, decimals = 1): number {
  if (!Number.isFinite(value)) return minimum;
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
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
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
