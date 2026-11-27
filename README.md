# PrivDark

Estudio audiovisual privado con IA (imagen → vídeo con Wan 2.2).

## Deploy

- **Frontend** → Cloudflare Pages  
  Build command: `pnpm build`  
  Output: `dist`  
  Variable: `PUBLIC_WORKER_URL` = URL del Worker desplegado

- **Worker** → `pnpm worker:deploy`  
  Secreto opcional: `HF_TOKEN` (Hugging Face)
