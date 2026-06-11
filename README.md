# Design System Generator — BricksMate

Genera tokens CSS para Bricks Builder: tipografía fluida, spacing, colores y border radius exportados como `clamp()` values listos para el Framework Importer.

---

## Setup local

**Requisitos:** Node 18+

```bash
npm install
npm run dev
```

Abre `http://localhost:5173` en el navegador.

---

## Build

```bash
npm run build
```

El output queda en `/dist`.

---

## Deploy en Netlify

### Opción A — Deploy automático via GitHub

1. Sube el proyecto a un repositorio de GitHub
2. Ve a [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import from Git**
3. Selecciona el repositorio
4. Netlify detecta el `netlify.toml` automáticamente:
   - Build command: `npm run build`
   - Publish directory: `dist`
5. Click **Deploy site**

### Opción B — Deploy manual via CLI

```bash
npm install -g netlify-cli
netlify login
npm run build
netlify deploy --prod --dir=dist
```

---

## OG Image

Para activar el preview en redes sociales, añade un archivo `public/og-image.png` (1200×630px).
El `index.html` ya tiene los meta tags configurados apuntando a `/og-image.png`.

---

## Estructura del proyecto

```
bricksmate-dsg/
├── index.html          ← Entry point con meta OG + favicon
├── vite.config.js
├── netlify.toml        ← Build config + SPA redirect
├── package.json
├── public/
│   ├── favicon.svg
│   └── og-image.png    ← Añadir manualmente (1200×630px)
└── src/
    ├── main.jsx        ← React 18 entry
    └── App.jsx         ← App completa (estado, steps, CSS generator)
```

---

## Próximos pasos

- **Chat 2:** Actualización visual — tokens shadcn-inspired (zinc/slate, HSL, dark mode ready)
- **Chat 3:** Deploy + OG image
