# PrivDark

Estudio audiovisual privado con IA (imagen → vídeo con Wan 2.2).

## Desarrollo

```bash
pnpm install

# Frontend (http://localhost:4321)
pnpm dev

# Worker API (http://localhost:8787)
pnpm worker:dev
```

Variables opcionales:
- `PUBLIC_WORKER_URL` — URL del worker (por defecto `http://localhost:8787`)
- `HF_TOKEN` — secreto de Cloudflare Worker para Hugging Face

## Deploy

- Frontend → Cloudflare Pages (directorio raíz, build `pnpm build`, output `dist`)
- Worker → `pnpm worker:deploy`
