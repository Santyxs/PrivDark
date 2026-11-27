/**
 * PrivDark API Worker.
 *
 * Receives an image and a motion prompt, submits the job to the public
 * Hugging Face Gradio Space, then streams its SSE response to the browser.
 * The optional HF_TOKEN is stored as a Worker secret and is never exposed
 * in the static frontend bundle.
 */

export interface Env {
  readonly ALLOWED_ORIGINS: string;
  readonly HF_SPACE_BASE: string;
  readonly HF_FN_NAME: string;
  readonly HF_TOKEN?: string;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1200;
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

interface UserParams {
  prompt?: string;
  steps?: number;
  duration?: number;
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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected generation error.";
        return withCors(jsonResponse({ error: message }, 502), origin, env);
      }
    }

    return withCors(jsonResponse({ error: "Not found" }, 404), origin, env);
  },
} satisfies ExportedHandler<Env>;

async function handleGenerate(req: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: "The request must be multipart form data." }, 400);
  }

  const imagePart = form.get("image") as unknown;
  const paramsRaw = form.get("params");

  if (!(imagePart instanceof File)) {
    return jsonResponse({ error: "No se ha recibido ninguna imagen." }, 400);
  }
  if (imagePart.size === 0) {
    return jsonResponse({ error: "La imagen está vacía." }, 400);
  }
  if (imagePart.size > MAX_IMAGE_BYTES) {
    return jsonResponse({ error: "La imagen supera el límite de 8 MB." }, 413);
  }
  if (!isSupportedImage(imagePart)) {
    return jsonResponse({ error: "Formato no compatible. Usa PNG, JPG o WEBP." }, 415);
  }

  const parsed = typeof paramsRaw === "string" ? safeJsonParse(paramsRaw) : null;
  const params: UserParams = isRecord(parsed) ? (parsed as UserParams) : {};
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) {
    return jsonResponse({ error: "Escribe una descripción del movimiento." }, 400);
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse({ error: `El texto no puede superar los ${MAX_PROMPT_LENGTH} caracteres.` }, 400);
  }

  const steps = clampInt(params.steps ?? DEFAULT_STEPS, MIN_STEPS, MAX_STEPS);
  const duration = clampFloat(params.duration ?? DEFAULT_DURATION, MIN_DURATION, MAX_DURATION, 1);
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
    throw new Error(`No se pudo abrir el flujo de resultados (${upstream.status})${detail}`);
  }

  return new Response(upstream.body, {
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
    throw new Error(`La subida a Hugging Face ha fallado (${response.status})${detail}`);
  }

  const paths: unknown = await response.json();
  if (!Array.isArray(paths) || typeof paths[0] !== "string" || !paths[0]) {
    throw new Error("Hugging Face ha devuelto una ruta de imagen no válida.");
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

  // Order mirrors the upstream Space's `ui_inputs` array.
  const data = [
    inputImage,
    null, // last_image
    prompt,
    steps,
    DEFAULT_NEGATIVE_PROMPT,
    duration,
    1, // guidance_scale
    1, // guidance_scale_2
    42, // seed (randomized by flag below)
    true, // randomize_seed
    6, // video quality
    "UniPCMultistep", // scheduler
    3.0, // flow_shift
    16, // native FPS
    false, // safe_mode
    true, // return video component
  ];

  const response = await fetch(`${env.HF_SPACE_BASE}/gradio_api/call/${env.HF_FN_NAME}`, {
    method: "POST",
    headers: hfHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ data }),
  });

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new Error(`Hugging Face ha rechazado la generación (${response.status})${detail}`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.event_id !== "string" || !payload.event_id) {
    throw new Error("Hugging Face no ha devuelto un identificador de generación.");
  }
  return payload.event_id;
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
  return `: ${text.replace(/\s+/g, " ").slice(0, 500)}`;
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
