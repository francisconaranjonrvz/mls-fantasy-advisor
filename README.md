# MLS Fantasy Advisor

Asesor automatico para una liga privada de **Mister Fantasy** (LaLiga, temporada 26-27).

Cada dia ingiere el estado completo de la liga, **reconstruye la informacion que Mister
oculta deliberadamente**, calcula las decisiones optimas de forma determinista y las deja
discutir con un asistente de IA que conoce el contrato, el reglamento y el estado real de
la competicion.

> Solo lectura. La aplicacion nunca ejecuta acciones en Mister: analiza y recomienda.

## El problema

En esta liga el ajuste `Permitir ver saldo de los rivales` esta en **No**. No sabes cuanto
dinero tiene nadie, asi que no puedes saber:

- Quien tiene capacidad para pagarte una clausula, y a que jugador tuyo.
- A cual de tus jugadores merece la pena subirle la clausula, y hasta que tramo.
- Si una puja es rentable, o si un clausulazo tuyo sale a cuenta.

Todo eso **es calculable**. Mister publica cada operacion con su importe exacto en el feed
de actividad, y todos los participantes empezaron con el mismo presupuesto.

## Como se reconstruye el saldo ajeno

El invariante: los 10 participantes empezaron con **50M** repartidos entre plantilla y caja.

```
saldo(t) = 50M
         - valor de la plantilla inicial
         + ventas - compras
         +/- clausulazos cobrados y pagados
         + bonificaciones de jornada     <- deterministas segun la clasificacion
         + quiniela                      <- NO observable
         - salarios                      <- ver docs/INCOGNITAS.md
```

Los tres primeros terminos salen del feed publico con importe exacto y contraparte. Las
bonificaciones son deterministas. Los dos ultimos no son observables, asi que se propagan
como incertidumbre: la aplicacion da una estimacion puntual **y un intervalo**, nunca un
numero falsamente exacto.

Esto no es una limitacion, es lo que lo hace util: si el intervalo de un rival queda por
debajo de la clausula de tu jugador, estas a salvo con certeza. Si lo cruza, no lo estas.

## La aritmetica de las clausulas

Documentada por Mister y verificada en los tests:

- Sea `B = max(precio de compra, valor de mercado)`.
- Clausula por defecto: `1,5 x B`, con suelo de 1M si el valor cae a 666.666 o menos.
- Tres tramos de subida (+100/+150/+200%): clausulas de `2,0B`, `2,5B`, `3,0B`.
- Coste de cada tramo: `0,2 x B x n`.

De donde sale el hecho mas util del juego: **el tipo de cambio es constante, 0,40 EUR de
saldo por cada 1 EUR de proteccion, en los tres tramos**. No hay tramo mas rentable que
otro, asi que la decision nunca es que tramo, sino a quien proteger.

Y como una clausula pagada **sube** si el jugador se revaloriza pero **se congela** si se
devalua, solo compensa proteger a quien esperas que suba: compras un multiplicador, no una
cifra.

## Arquitectura

```
apps/scraper            Node + TS. Login, ingesta, validacion, snapshot y analisis.
apps/web                React + Vite. Dashboard estatico.
apps/api                Cloudflare Worker. Sirve la web y expone /api/chat.
packages/core           Tipos, esquemas zod y la configuracion real de la liga.
packages/engine         Dominio puro, sin E/S, cubierto por tests.
packages/mister-client  Cliente tipado de la API no documentada de Mister.
data/2026-27            Snapshots append-only versionados en git.
```

**Principio rector: la IA nunca hace cuentas.** Todo lo numerico se calcula de forma
determinista en `packages/engine` y se le entrega ya resuelto. El modelo se usa para lo que
sabe hacer: interpretar noticias de lesiones, valorar rotaciones y explicar el plan.

### Por que es gratis y siempre esta activo

| Pieza | Servicio | Motivo |
|---|---|---|
| Scheduler | GitHub Actions en repo publico | Minutos ilimitados y gratuitos en repos publicos. |
| Precision horaria | Cloudflare Cron Trigger que dispara `workflow_dispatch` | El cron de GitHub sufre retrasos de horas. |
| Base de datos | El propio repo git | Unos pocos MB por temporada. Nada que se pause ni pida tarjeta. |
| Web y API | Un Cloudflare Worker con `assets` | Los assets estaticos no consumen cuota. |

## Puesta en marcha

```bash
pnpm install
pnpm test
pnpm ingest:demo
```

`pnpm ingest:demo` recorre el pipeline entero (ingesta, validacion, analisis e informe) con
una liga sintetica, sin credenciales y sin llamar a Mister.

Para conectarlo a tu liga de verdad y desplegar el dashboard, ver
[docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

### Acceso a Mister

Quien entra en Mister con "Continuar con Google" no tiene contrasena nativa, asi que el
login por API no le sirve. Para ese caso, `pnpm capture:session` abre un navegador, te deja
entrar a mano y guarda la sesion resultante, que es lo que usa el scraper. El script valida
la sesion contra Mister antes de dartela, para que no descubras dos dias despues que no
valia. Detalles en [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

Las credenciales viven como **GitHub Actions secrets** y la clave de IA como secreto del
Worker. Nunca se commitean: el repo es publico y `.gitignore` bloquea `.env`, `.dev.vars`,
cookies y sesiones.

## Estado

- Motor de dominio, cliente de Mister, ingesta, Worker y dashboard: **hechos**, con 128 tests.
- Ingesta programada cuatro veces al dia en GitHub Actions: **hecha**.
- Falta capturar la sesion de Mister y lanzar la primera ingesta, y confirmar en la app
  las cinco incognitas de [docs/INCOGNITAS.md](docs/INCOGNITAS.md), que estrechan
  bastante las estimaciones de saldo.

## Reglas de la liga

`docs-liga/` contiene el contrato y el reglamento firmados. `docs/REGLAS.md` es la version
destilada que se le inyecta al asistente como contexto.

## Licencia

MIT. Proyecto personal, sin relacion con Mundo Deportivo ni con Mister Fantasy.
