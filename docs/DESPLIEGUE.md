# Puesta en marcha

Tres pasos: credenciales, primera ingesta y despliegue del dashboard. Todo el
stack es gratuito y no requiere tarjeta.

## 1. Acceso a Mister

Aqui hay una bifurcacion segun como entres en Mister.

### Si entras con "Continuar con Google" (lo habitual)

Tu cuenta **no tiene contrasena nativa** de Mister, asi que el login por API es
imposible. La solucion es capturar la sesion una vez desde un navegador real,
donde el OAuth de Google funciona con normalidad.

```bash
pnpm --filter @mls/scraper exec playwright install chromium   # solo la primera vez
pnpm capture:session
```

Se abre un navegador. Inicia sesion como haces siempre, espera a ver tu liga con
el menu Mercado / Equipo / Tabla, y vuelve a la terminal a pulsar Enter.

El script **comprueba la sesion contra Mister antes de dartela**: si te imprime
un valor, es porque ya ha leido tu saldo con ella. Copia ese valor en el secret
`MISTER_SESSION`.

> Automatizar el login de Google desde el script seria mala idea por dos motivos
> independientes: Google detecta y bloquea navegadores automatizados, y meter las
> credenciales de tu cuenta de Google entera en un script para leer una liga de
> fantasy es un riesgo desproporcionado. Aqui el navegador lo conduces tu.

#### Captura manual, sin Playwright

Si prefieres no instalar nada:

1. Entra en `mister.mundodeportivo.com` en Chrome y ve a tu liga.
2. Abre DevTools con F12 y ve a `Application > Cookies > https://mister.mundodeportivo.com`.
3. Copia el **valor** de la cookie `refresh-token` (es un texto largo que empieza por `ey`).
4. Pegalo tal cual en el secret `MISTER_SESSION`.

El scraper acepta ese valor suelto, una cabecera `Cookie` completa, o el JSON
del capturador. No hace falta darle un formato concreto.

### Si tu cuenta tiene contrasena propia de Mister

Merece la pena comprobarlo aunque entres con Google: en la pantalla de acceso,
escribe tu email y pulsa "Recuperar contrasena". Si te llega el correo, podras
fijar una contrasena y usar la via simple, que no caduca nunca.

En ese caso, en vez de `MISTER_SESSION` define `MISTER_EMAIL` y `MISTER_PASSWORD`.
No es la contrasena de tu cuenta de Google: es una contrasena de Mister.

### Donde van los secrets

`Settings > Secrets and variables > Actions`, pestana **Secrets**, boton
**New repository secret** (repository secrets, no environment secrets: los
workflows no declaran ningun environment).

| Secret | Cuando |
|---|---|
| `MISTER_SESSION` | Si entras con Google |
| `MISTER_EMAIL` + `MISTER_PASSWORD` | Si tienes contrasena nativa |
| `MISTER_LEAGUE_ID` | Opcional; si lo dejas vacio se detecta solo |

Los secrets no se pasan a los workflows que vienen de un fork, asi que el
repositorio puede ser publico sin riesgo. Trata `MISTER_SESSION` como una
contrasena: da acceso a tu cuenta.

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
