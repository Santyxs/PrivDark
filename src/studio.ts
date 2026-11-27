/** Client-side interaction for the PrivDark studio. */

const WORKER_URL = import.meta.env.PUBLIC_WORKER_URL;
if (!WORKER_URL) {
  throw new Error("PUBLIC_WORKER_URL no está definida. Configúrala en el entorno de deploy.");
}
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1200;
const HF_SPACE_BASE = "https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space";

const $ = <T extends Element>(selector: string, root: ParentNode = document): T => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Falta un elemento de interfaz: ${selector}`);
  return element;
};

const dropzone = $<HTMLLabelElement>("[data-dropzone]");
const fileInput = $<HTMLInputElement>("[data-file-input]");
const dropEmpty = $<HTMLDivElement>("[data-dropzone-empty]");
const dropPreview = $<HTMLImageElement>("[data-dropzone-preview]");
const promptEl = $<HTMLTextAreaElement>("[data-prompt]");
const promptCount = $<HTMLSpanElement>("[data-prompt-count]");
const durationEl = $<HTMLInputElement>("[data-duration]");
const durationVal = $<HTMLSpanElement>("[data-duration-value]");
const stepsEl = $<HTMLInputElement>("[data-steps]");
const stepsVal = $<HTMLSpanElement>("[data-steps-value]");
const generateBtn = $<HTMLButtonElement>("[data-generate]");
const buttonLabel = $<HTMLSpanElement>("[data-button-label]");
const spinnerEl = $<HTMLSpanElement>("[data-spinner]");
const statusEl = $<HTMLParagraphElement>("[data-status]");
const resultEmpty = $<HTMLDivElement>("[data-result-empty]");
const resultLoad = $<HTMLDivElement>("[data-result-loading]");
const loadingMsg = $<HTMLParagraphElement>("[data-loading-message]");
const resultVideo = $<HTMLVideoElement>("[data-result-video]");
const downloadLink = $<HTMLAnchorElement>("[data-download]");
const historyWrap = $<HTMLDivElement>("[data-history-wrap]");
const historyList = $<HTMLUListElement>("[data-history]");

const state = {
  file: null as File | null,
  busy: false,
  previewUrl: null as string | null,
};

function acceptFile(file: File): void {
  const supported = new Set(["image/png", "image/jpeg", "image/webp"]);
  const supportedByName = /\.(png|jpe?g|webp)$/i.test(file.name);

  if (!supported.has(file.type.toLowerCase()) && !supportedByName) {
    setStatus("Formato no compatible. Selecciona PNG, JPG o WEBP.", "error");
    return;
  }
  if (file.size === 0) {
    setStatus("El archivo está vacío.", "error");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    setStatus("La imagen supera el límite de 8 MB.", "error");
    return;
  }

  state.file = file;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  dropPreview.src = state.previewUrl;
  dropPreview.classList.remove("hidden");
  dropEmpty.classList.add("hidden");
  refreshGenerateButton();
  setStatus("Imagen preparada. Ya puedes generar el vídeo.", "success");
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) acceptFile(file);
});

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.setAttribute("data-active", "true");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, () => dropzone.setAttribute("data-active", "false"));
}

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = (event as DragEvent).dataTransfer?.files?.[0];
  if (file) acceptFile(file);
});

window.addEventListener("paste", (event: ClipboardEvent) => {
  const file = event.clipboardData?.files?.[0];
  if (file) acceptFile(file);
});

promptEl.maxLength = MAX_PROMPT_LENGTH;
promptEl.addEventListener("input", () => {
  promptCount.textContent = `${promptEl.value.length} / ${MAX_PROMPT_LENGTH}`;
  refreshGenerateButton();
});

function bindFixedValue(input: HTMLInputElement, display: HTMLSpanElement, suffix = ""): void {
  const sync = () => { display.textContent = `${input.value}${suffix}`; };
  input.addEventListener("input", sync);
  sync();
}
bindFixedValue(durationEl, durationVal, "s");
bindFixedValue(stepsEl, stepsVal);

function refreshGenerateButton(): void {
  const ready = Boolean(state.file) && promptEl.value.trim().length > 0 && !state.busy;
  generateBtn.disabled = !ready;
}

type StatusTone = "info" | "error" | "success";
function setStatus(message: string, tone: StatusTone = "info"): void {
  statusEl.textContent = message;
  statusEl.classList.remove("text-rose-400", "text-brand-glow", "text-slate-500");
  statusEl.classList.add(
    tone === "error" ? "text-rose-400" : tone === "success" ? "text-brand-glow" : "text-slate-500",
  );
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  spinnerEl.classList.toggle("hidden", !busy);
  buttonLabel.textContent = busy ? "Generando..." : "Generar vídeo";
  refreshGenerateButton();
}

function showResultState(status: "empty" | "loading" | "ready"): void {
  resultEmpty.classList.toggle("hidden", status !== "empty");
  resultLoad.classList.toggle("hidden", status !== "loading");
  resultVideo.classList.toggle("hidden", status !== "ready");
  downloadLink.classList.toggle("hidden", status !== "ready");
}

generateBtn.addEventListener("click", async () => {
  const image = state.file;
  const prompt = promptEl.value.trim();
  if (!image || !prompt || state.busy) return;

  setBusy(true);
  showResultState("loading");
  setStatus("Enviando la imagen y solicitando GPU a Hugging Face...");
  const stopLoadingMessages = startLoadingMessages();

  try {
    const form = new FormData();
    form.append("image", image, image.name);
    form.append("params", JSON.stringify({ prompt, steps: Number(stepsEl.value) }));

    const response = await fetch(`${WORKER_URL.replace(/\/$/, "")}/generate`, {
      method: "POST",
      body: form,
    });

    if (!response.ok || !response.body) {
      throw new Error(await readErrorMessage(response));
    }

    const videoUrl = await consumeSseUntilComplete(response.body);
    resultVideo.pause();
    resultVideo.src = videoUrl;
    resultVideo.load();
    downloadLink.href = videoUrl;
    downloadLink.setAttribute("download", `privdark-${Date.now()}.mp4`);
    showResultState("ready");
    setStatus("Generación completada. Tu vídeo está listo.", "success");
    addToHistory(videoUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`No se pudo generar el vídeo: ${message}`, "error");
    showResultState("empty");
  } finally {
    stopLoadingMessages();
    setBusy(false);
  }
});

function startLoadingMessages(): () => void {
  const messages = [
    "Preparando la imagen...",
    "Esperando a que Hugging Face asigne una GPU...",
    "Cargando el modelo Wan 2.2...",
    "Generando los fotogramas del vídeo...",
    "Montando el archivo MP4...",
    "Finalizando la generación...",
  ];
  let index = 0;
  loadingMsg.textContent = messages[index] ?? "Generando vídeo...";
  const timer = window.setInterval(() => {
    index = Math.min(index + 1, messages.length - 1);
    loadingMsg.textContent = messages[index] ?? "Generando vídeo...";
  }, 9000);
  return () => window.clearInterval(timer);
}

async function consumeSseUntilComplete(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const result = parseGenerationEvent(chunk);
        if (result) return result;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const result = parseGenerationEvent(buffer);
      if (result) return result;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  throw new Error("La conexión terminó antes de recibir el vídeo. Prueba de nuevo.");
}

function parseGenerationEvent(raw: string): string | null {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");

  if (eventName === "error") {
    let message = data;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "string") message = parsed;
      else if (parsed && typeof parsed === "object" && "message" in parsed) {
        const value = (parsed as { message?: unknown }).message;
        if (typeof value === "string") message = value;
      }
    } catch {
      // Keep the original server message when it is not JSON.
    }
    throw new Error(message || "Hugging Face ha devuelto un error.");
  }

  if (eventName !== "complete") return null;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error("Hugging Face ha devuelto un resultado ilegible.");
  }

  const firstResult = Array.isArray(payload) ? payload[0] : null;
  const videoUrl = extractVideoUrl(firstResult);
  if (!videoUrl) throw new Error("La generación terminó, pero no se recibió el archivo de vídeo.");
  return videoUrl;
}

function extractVideoUrl(fileData: unknown): string | null {
  if (typeof fileData === "string") {
    if (/^https?:\/\//i.test(fileData)) return fileData;
    return new URL(`/gradio_api/file=${fileData.replace(/^\//, "")}`, HF_SPACE_BASE).href;
  }

  if (!fileData || typeof fileData !== "object") return null;
  const data = fileData as { url?: unknown; path?: unknown };
  const candidate = typeof data.url === "string" ? data.url : data.path;
  if (typeof candidate !== "string" || !candidate) return null;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return new URL(`/gradio_api/file=${candidate.replace(/^\//, "")}`, HF_SPACE_BASE).href;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    if (body && typeof body === "object" && "error" in body) {
      const message = (body as { error?: unknown }).error;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    // Fall back to the response text.
  }
  const bodyText = await response.text().catch(() => "");
  return bodyText || `${response.status} ${response.statusText}`;
}

function addToHistory(url: string): void {
  historyWrap.classList.remove("hidden");
  const item = document.createElement("li");
  item.className = "history-item";
  item.title = "Volver a mostrar este vídeo";

  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.className = "h-20 w-32 object-cover";

  item.addEventListener("mouseenter", () => video.play().catch(() => undefined));
  item.addEventListener("mouseleave", () => {
    video.pause();
    video.currentTime = 0;
  });
  item.addEventListener("click", () => {
    resultVideo.pause();
    resultVideo.src = url;
    resultVideo.load();
    downloadLink.href = url;
    downloadLink.setAttribute("download", `privdark-${Date.now()}.mp4`);
    showResultState("ready");
  });

  item.appendChild(video);
  historyList.prepend(item);
}

showResultState("empty");
refreshGenerateButton();
