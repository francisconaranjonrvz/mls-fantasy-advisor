# Puesta en marcha

Tres pasos: credenciales, primera ingesta y despliegue del dashboard. Todo el
stack es gratuito y no requiere tarjeta.

## 1. Credenciales (GitHub)

En `Settings > Secrets and variables > Actions > New repository secret`:

| Secret | Valor |
|---|---|
| `MISTER_EMAIL` | El correo de tu cuenta de Mister |
| `MISTER_PASSWORD` | Su contraseña |
| `MISTER_LEAGUE_ID` | Opcional. Si lo dejas vacio, el scraper lo detecta solo |

Los secrets no se pasan a los workflows que vienen de un fork, asi que el
repositorio puede ser publico sin riesgo. Nunca escribas estos valores en un
fichero del repositorio.

## 2. Primera ingesta

Ve a la pestaña `Actions`, elige el workflow **Ingesta diaria** y pulsa
`Run workflow`. La primera vez conviene marcar `dry_run` para comprobar que el
login funciona y que se parsea todo, sin escribir nada.

Si sale bien, vuelve a lanzarlo sin `dry_run`. El job escribira en `data/` y
hara commit. A partir de ahi el cron se encarga solo.

El diagnostico del dia aparece en el resumen del propio run, asi que se puede
leer desde el movil sin abrir el repositorio.

### Rellenar el baseline (importante)

`data/2026-27/baseline.json` guarda el valor de la plantilla que le toco a cada
manager al empezar la temporada. Es el unico dato del pasado que no se puede
deducir de una foto de hoy, y sin el los saldos estimados arrastran un sesgo
constante.

```json
{
  "initialSquadValueByManager": {
    "4410": 39300000,
    "4411": 38000000
  }
}
```

Los identificadores salen de `data/2026-27/managers.csv` despues de la primera
ingesta. Si no tienes los valores exactos, pon tu mejor estimacion: el bloque
«Fiabilidad de las estimaciones» del diagnostico te dira cuanto te desvias,
porque compara la reconstruccion con tu saldo real, que si es dato cierto.

## 3. Dashboard y chat (Cloudflare)

El Worker sirve el dashboard y expone `/api/chat`. Hace falta porque la clave
de la IA no puede viajar al navegador: cualquier clave que llegue al cliente es
publica.

```bash
pnpm install
pnpm --filter @mls/web build
cd apps/api
npx wrangler login
npx wrangler secret put NVIDIA_API_KEY   # pega tu clave nvapi-...
npx wrangler deploy
```

Queda publicado en `https://mls-fantasy-advisor.<tu-subdominio>.workers.dev`.

Conviene ademas fijar el origen permitido para que nadie que dé con la URL
pueda gastarte la cuota de IA:

```bash
npx wrangler secret put ALLOWED_ORIGIN   # https://mls-fantasy-advisor.<...>.workers.dev
```

### Si NVIDIA se queda sin creditos

El nivel gratuito de build.nvidia.com funciona por creditos y puede agotarse.
Hay un respaldo dentro de la propia Cloudflare, con 10.000 neuronas diarias
gratis. Para activarlo, descomenta el binding en `apps/api/wrangler.jsonc`:

```jsonc
"ai": { "binding": "AI" }
```

y vuelve a desplegar. El codigo lo detecta solo y lo encadena detras de NVIDIA.
Viene desactivado por defecto porque ese binding obliga a `wrangler dev` a
abrir conexion remota, lo que rompe el desarrollo local de quien no tenga
cuenta.

Tambien puedes cambiar de modelo sin tocar codigo:

```bash
npx wrangler secret put NVIDIA_MODEL   # p.ej. openai/gpt-oss-120b
```

## Desarrollo local

```bash
pnpm install
pnpm test
cp .env.example .env        # tus credenciales de Mister
pnpm ingest:demo            # pipeline completo con datos sinteticos
pnpm ingest:dry             # ingesta real, sin escribir nada
```

Para el dashboard y el chat en local hacen falta dos procesos:

```bash
cd apps/api && npx wrangler dev          # API en :8787
pnpm --filter @mls/web dev               # web en :5173, con proxy a :8787
```

Las variables locales del Worker van en `apps/api/.dev.vars`, que esta en
`.gitignore`:

```
NVIDIA_API_KEY=nvapi-...
DATA_BASE_URL=https://raw.githubusercontent.com/<usuario>/mls-fantasy-advisor/main
```

## Que revisar de vez en cuando

- **La calibracion.** Si el diagnostico dice que la reconstruccion se desvia de
  tu saldo real, algo ha cambiado: normalmente el baseline o una transaccion
  que no se esta parseando.
- **Los avisos de la ingesta.** Aparecen al final del diagnostico y suelen
  delatar un cambio de HTML en Mister antes de que rompa nada.
- **`docs/INCOGNITAS.md`.** Cinco cosas que no pude verificar y que, al
  confirmarlas en la app, estrechan bastante las estimaciones.
