import Plyr from 'plyr';

      type Tone = "info" | "error" | "success";
      type ResultState = "empty" | "loading" | "ready";

      const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
      const MAX_PROMPT_LENGTH = 500;
      const MAX_HISTORY_ITEMS = 6;
      const HF_SPACE = new URL("https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space");
      const rawWorkerUrl = (import.meta.env.PUBLIC_WORKER_URL as string | undefined)?.trim();
      if (!rawWorkerUrl) {
        throw new Error("Falta PUBLIC_WORKER_URL en el build. Configura la URL del Worker en Cloudflare Pages.");
      }
      const workerUrl = rawWorkerUrl.replace(/\/+$/, "");
      const generateUrl = `${workerUrl}/generate`;

      const q = <T extends Element>(selector: string): T => {
        const element = document.querySelector<T>(selector);
        if (!element) throw new Error(`Elemento no encontrado en la página: ${selector}`);
        return element;
      };

      const dropzone = q<HTMLLabelElement>("[data-dropzone]");
      const fileInput = q<HTMLInputElement>("[data-file-input]");
      const dropzoneEmpty = q<HTMLElement>("[data-dropzone-empty]");
      const preview = q<HTMLImageElement>("[data-dropzone-preview]");
      const promptInput = q<HTMLTextAreaElement>("[data-prompt]");
      const promptCount = q<HTMLElement>("[data-prompt-count]");
      const modelInput = q<HTMLSelectElement>("[data-model]");
      const modelTrigger = q<HTMLButtonElement>("[data-model-trigger]");
      const modelMenu = q<HTMLElement>("[data-model-menu]");
      const modelCurrent = q<HTMLElement>("[data-model-current]");
      const modelBadge = q<HTMLElement>("[data-model-badge]");
      const modelOptions = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-model-option]"));
      const modelNames: Record<string, string> = { wan22: "Wan 2.2", ltx23: "LTX-2.3", cogvideox: "CogVideoX-5B", hunyuan15: "HunyuanVideo 1.5", minimaxh3: "MiniMax H3", minimaxh3turbo: "MiniMax H3 Turbo" };
      function syncModelPicker(): void {
        const audio = modelInput.value === "ltx23";
        modelCurrent.textContent = modelNames[modelInput.value] ?? modelInput.value;
        modelBadge.textContent = audio ? "CON AUDIO" : "SIN AUDIO";
        modelBadge.classList.toggle("audio", audio);
        for (const option of modelOptions) {
          const selected = option.dataset.modelOption === modelInput.value;
          option.classList.toggle("selected", selected);
          option.setAttribute("aria-selected", String(selected));
        }
      }
      modelTrigger.addEventListener("click", () => {
        const open = modelMenu.hidden;
        modelMenu.hidden = !open;
        modelTrigger.setAttribute("aria-expanded", String(open));
      });
      for (const option of modelOptions) option.addEventListener("click", () => {
        modelInput.value = option.dataset.modelOption ?? "wan22";
        syncModelPicker();
        modelMenu.hidden = true;
        modelTrigger.setAttribute("aria-expanded", "false");
      });
      document.addEventListener("click", (event) => {
        if (!(event.target instanceof Node) || !event.target.parentElement?.closest("[data-model-picker]")) {
          modelMenu.hidden = true;
          modelTrigger.setAttribute("aria-expanded", "false");
        }
      });
      syncModelPicker();
      const stepsInput = q<HTMLInputElement>("[data-steps]");
      const stepsValue = q<HTMLElement>("[data-steps-value]");
      const durationInput = q<HTMLInputElement>("[data-duration]");
      const durationValue = q<HTMLElement>("[data-duration-value]");
      const outputMeta = q<HTMLElement>("[data-output-meta]");
      const generateButton = q<HTMLButtonElement>("[data-generate]");
      const buttonLabel = q<HTMLElement>("[data-button-label]");
      const spinner = q<HTMLElement>("[data-spinner]");
      const statusMessage = q<HTMLElement>("[data-status]");
      const emptyResult = q<HTMLElement>("[data-result-empty]");
      const loadingResult = q<HTMLElement>("[data-result-loading]");
      const loadingMessage = q<HTMLElement>("[data-loading-message]");
      const resultVideo = q<HTMLVideoElement>("[data-result-video]");
      const resultFrame = q<HTMLElement>(".result-frame");
      const downloadLink = q<HTMLAnchorElement>("[data-download]");

      // Inicializar Plyr
      const player = new Plyr(resultVideo, {
        controls: ['play', 'progress', 'current-time', 'mute', 'volume', 'fullscreen'],
      });

      const historyWrap = q<HTMLElement>("[data-history-wrap]");
      const historyList = q<HTMLUListElement>("[data-history]");

      let selectedFile: File | null = null;
      let previewUrl: string | null = null;
      let currentDownloadUrl: string | null = null;
      let isGenerating = false;

      const loadingMessages = [
        "Subiendo imagen...",
        "Esperando GPU en Hugging Face...",
        "Cargando el modelo...",
        "Generando fotogramas...",
        "Montando el MP4...",
        "Casi listo...",
      ];

      function setStatus(message: string, tone: Tone = "info"): void {
        statusMessage.textContent = message;
        statusMessage.className = `status-msg${tone === "error" ? " error" : tone === "success" ? " success" : ""}`;
      }

      function updateGenerateButton(): void {
        generateButton.disabled = !(selectedFile && promptInput.value.trim() && !isGenerating);
      }

      function setResultState(state: ResultState): void {
        const hasVideo = state === "ready";
        emptyResult.classList.toggle("hide", state !== "empty");
        loadingResult.classList.toggle("hide", state !== "loading");
        
        // En lugar de ocultar el vídeo nativo, ocultamos el contenedor de Plyr
        const plyrContainer = document.querySelector('.plyr');
        if (plyrContainer) {
          plyrContainer.classList.toggle("hide", !hasVideo);
        }
        
        resultFrame.classList.toggle("has-video", hasVideo);
        downloadLink.classList.toggle("show", hasVideo);
        
        emptyResult.hidden = state !== "empty";
        loadingResult.hidden = state !== "loading";
      }

      resultVideo.addEventListener("error", () => {
        if (!resultVideo.src) return;
        setStatus("El vídeo no se ha podido cargar o reproducir. Prueba a descargarlo.", "error");
      });
      resultVideo.addEventListener("loadedmetadata", () => {
        resultFrame.classList.add("has-video");
      });

      function clearSelectedImage(): void {
        selectedFile = null;
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
          previewUrl = null;
        }
        preview.removeAttribute("src");
        preview.classList.remove("show");
        dropzoneEmpty.classList.remove("hide");
        updateGenerateButton();
      }

      function selectImage(file: File): void {
        const supportedType = /^image\/(png|jpeg|webp)$/i.test(file.type);
        const supportedName = /\.(png|jpe?g|webp)$/i.test(file.name);
        if (!supportedType && !supportedName) {
          clearSelectedImage();
          setStatus("Formato no válido. Solo PNG, JPG o WEBP.", "error");
          return;
        }
        if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
          clearSelectedImage();
          setStatus(
            file.size ? "La imagen supera 8 MB. Elige una más ligera." : "El archivo está vacío. Elige otra imagen.",
            "error",
          );
          return;
        }

        selectedFile = file;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(file);
        preview.src = previewUrl;
        preview.classList.add("show");
        dropzoneEmpty.classList.add("hide");
        updateGenerateButton();
        setStatus("Imagen cargada. Ya puedes generar.", "success");
      }

      function formatDuration(value: string): string {
        return Number(value).toFixed(1);
      }

      function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
      }

      function toVideoUrl(value: unknown): string | null {
        let candidate: unknown = value;
        if (isRecord(value)) {
          candidate = typeof value.url === "string" && value.url ? value.url : value.path;
        }
        if (typeof candidate !== "string" || !candidate.trim()) return null;

        const path = candidate.trim();
        if (/^https?:\/\//i.test(path)) {
          try {
            const url = new URL(path);
            return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
          } catch {
            return null;
          }
        }

        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
        return new URL(`/gradio_api/file=${encodedPath}`, HF_SPACE).href;
      }

      function parseSseEvent(raw: string): string | null {
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length === 0) return null;

        const data = dataLines.join("\n");
        if (event === "error") {
          let message = data;
          try {
            const parsed: unknown = JSON.parse(data);
            if (typeof parsed === "string") message = parsed;
            else if (isRecord(parsed)) {
              for (const key of ["message", "error", "detail"]) {
                if (typeof parsed[key] === "string" && parsed[key]) {
                  message = parsed[key];
                  break;
                }
              }
            }
          } catch {
            // Gradio can return plain text instead of JSON.
          }
          throw new Error(message || "Error del modelo en Hugging Face. Revisa el prompt o inténtalo más tarde.");
        }
        if (event !== "complete") return null;

        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          throw new Error("Hugging Face terminó la generación, pero devolvió una respuesta no válida.");
        }
        const url = toVideoUrl(Array.isArray(payload) ? payload[0] : null);
        if (!url) throw new Error("La generación terminó sin devolver un vídeo. Prueba a reducir duración o pasos.");
        return url;
      }

      async function readSseStream(body: ReadableStream<Uint8Array>): Promise<string> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let separator = /\r?\n\r?\n/.exec(buffer);
            while (separator && separator.index !== undefined) {
              const event = buffer.slice(0, separator.index);
              buffer = buffer.slice(separator.index + separator[0].length);
              const videoUrl = parseSseEvent(event);
              if (videoUrl) return videoUrl;
              separator = /\r?\n\r?\n/.exec(buffer);
            }
          }

          buffer += decoder.decode();
          if (buffer.trim()) {
            const videoUrl = parseSseEvent(buffer);
            if (videoUrl) return videoUrl;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }

        throw new Error("La conexión se cerró antes de recibir el vídeo (timeout o Space no disponible). Inténtalo más tarde.");
      }

      async function getResponseError(response: Response): Promise<string> {
        const body = (await response.text().catch(() => "")).trim();
        if (body) {
          try {
            const parsed: unknown = JSON.parse(body);
            if (isRecord(parsed)) {
              for (const key of ["error", "message", "detail"]) {
                if (typeof parsed[key] === "string" && parsed[key]) return parsed[key];
              }
            }
          } catch {
            // Keep the original response text for non-JSON errors.
          }
          return body;
        }
        return `El servidor respondió con error ${response.status} (${response.statusText || "sin detalle"}).`;
      }

      function setDownloadUrl(url: string): void {
        currentDownloadUrl = url;
        downloadLink.href = url;
      }

      downloadLink.addEventListener("click", async (event) => {
        const url = currentDownloadUrl;
        event.preventDefault();
        if (!url) return;

        try {
          const response = await fetch(url, { mode: "cors", credentials: "omit" });
          if (!response.ok) throw new Error(`No se pudo descargar el MP4 (código ${response.status}).`);
          const blob = await response.blob();
          if (!blob.size) throw new Error("El servidor de vídeo devolvió un archivo vacío.");
          const objectUrl = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = objectUrl;
          anchor.download = `privdark-${Date.now()}.mp4`;
          anchor.style.display = "none";
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        } catch (error: unknown) {
          setStatus(
            error instanceof Error ? error.message : "No se pudo descargar el vídeo. Prueba a abrir el enlace directamente.",
            "error",
          );
          window.location.assign(url);
        }
      });

      function openHistoryVideo(url: string): void {
        player.pause();
        player.source = {
          type: 'video',
          sources: [{ src: url, provider: 'html5' }]
        };
        setResultState("ready");
        setDownloadUrl(url);
      }

      function addHistoryItem(url: string): void {
        historyWrap.classList.add("show");
        const item = document.createElement("li");
        item.className = "history-item";
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.setAttribute("aria-label", "Reproducir vídeo generado");

        const video = document.createElement("video");
        video.src = url;
        video.muted = true;
        video.loop = false;
        video.playsInline = true;
        video.preload = "auto";
        item.append(video);
        
        const playPreview = () => {
          if (!video.ended && video.paused) void video.play().catch(() => undefined);
        };
        video.addEventListener("loadeddata", playPreview, { once: true });
        const previewObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) playPreview();
            else video.pause();
          }
        }, { threshold: 0.15 });
        previewObserver.observe(item);
        item.addEventListener("click", () => openHistoryVideo(url));
        item.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openHistoryVideo(url);
          }
        });

        historyList.prepend(item);
        while (historyList.childElementCount > MAX_HISTORY_ITEMS) {
          const oldest = historyList.lastElementChild;
          if (!oldest) break;
          const oldVideo = oldest.querySelector("video");
          if (oldVideo) {
            oldVideo.pause();
            oldVideo.removeAttribute("src");
            oldVideo.load();
          }
          oldest.remove();
        }
      }

      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file) selectImage(file);
        fileInput.value = "";
      });

      for (const eventName of ["dragenter", "dragover"] as const) {
        dropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          dropzone.dataset.active = "true";
        });
      }
      for (const eventName of ["dragleave", "drop"] as const) {
        dropzone.addEventListener(eventName, () => {
          dropzone.dataset.active = "false";
        });
      }
      dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        const file = (event as DragEvent).dataTransfer?.files[0];
        if (file) selectImage(file);
      });
      window.addEventListener("paste", (event: ClipboardEvent) => {
        const file = event.clipboardData?.files[0];
        if (file) selectImage(file);
      });

      promptInput.maxLength = MAX_PROMPT_LENGTH;
      promptInput.addEventListener("input", () => {
        promptCount.textContent = `${promptInput.value.length} / ${MAX_PROMPT_LENGTH}`;
        updateGenerateButton();
      });
      stepsInput.addEventListener("input", () => {
        stepsValue.textContent = stepsInput.value;
      });
      durationInput.addEventListener("input", () => {
        const duration = formatDuration(durationInput.value);
        durationValue.textContent = duration;
        outputMeta.textContent = `MP4 · ${duration} s`;
      });

      generateButton.addEventListener("click", async () => {
        const prompt = promptInput.value.trim();
        if (!selectedFile || !prompt || isGenerating) return;

        isGenerating = true;
        generateButton.setAttribute("aria-busy", "true");
        spinner.classList.add("show");
        buttonLabel.textContent = "Generando...";
        updateGenerateButton();
        
        player.pause();
        setResultState("loading");
        setStatus("Enviando imagen y parámetros al Worker...");

        let messageIndex = 0;
        loadingMessage.textContent = loadingMessages[0];
        const progressTimer = window.setInterval(() => {
          messageIndex = Math.min(messageIndex + 1, loadingMessages.length - 1);
          loadingMessage.textContent = loadingMessages[messageIndex];
        }, 9_000);

        try {
          const form = new FormData();
          form.append("image", selectedFile, selectedFile.name);
          form.append("params", JSON.stringify({
            prompt,
            model: modelInput.value,
            steps: Number(stepsInput.value),
            duration: Number(durationInput.value),
          }));

          const response = await fetch(generateUrl, {
            method: "POST",
            body: form,
            cache: "no-store",
            credentials: "omit",
          });
          if (!response.ok || !response.body) throw new Error(await getResponseError(response));

          const url = await readSseStream(response.body);
          
          // Usar Plyr para cargar la nueva fuente
          player.source = {
            type: 'video',
            sources: [{ src: url, provider: 'html5' }]
          };
          
          setResultState("ready");
          setDownloadUrl(url);
          setStatus("Vídeo generado. Ya puedes reproducirlo o descargarlo.", "success");
          addHistoryItem(url);
        } catch (error: unknown) {
          setStatus(error instanceof Error ? error.message : `Error inesperado: ${String(error)}`, "error");
          setResultState("empty");
        } finally {
          window.clearInterval(progressTimer);
          isGenerating = false;
          generateButton.removeAttribute("aria-busy");
          spinner.classList.remove("show");
          buttonLabel.textContent = "Generar";
          updateGenerateButton();
        }
      });

      window.addEventListener("pagehide", (event) => {
        if (!event.persisted && previewUrl) URL.revokeObjectURL(previewUrl);
      }, { once: true });

      setResultState("empty");
      updateGenerateButton();
