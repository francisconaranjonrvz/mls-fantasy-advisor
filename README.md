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
saldo(t) = caja inicial                  <- 50M menos la plantilla repartida
         + ventas - compras              <- del feed, con importe exacto
         +/- clausulazos                 <- del feed, con importe exacto
         + bonificaciones de jornada     <- exactas: dependen solo del puesto
         + quiniela                      <- acotada: 25.000 por acierto, 10 partidos
         - modificaciones de clausula    <- acotadas por las clausulas visibles
         - salarios                      <- comprobado que estan apagados
```

La aplicacion da una estimacion puntual **y un intervalo**, nunca un numero falsamente
exacto. Y el trabajo de verdad esta en estrechar ese intervalo sin mentir: cada termino
que parecia desconocido resulto estar acotado por algo observable.

- **La caja inicial** aparece como un apunte en el libro propio, antes de la primera
  jornada. Mister no reparte 50M de saldo: reparte plantilla y acredita el resto.
- **Las bonificaciones** dependen solo del puesto de cada jornada, y `/ajax/sw/progression`
  publica ese puesto para los diez participantes. Dejan de ser un rango de 1,0M a 1,5M por
  jornada y pasan a ser una cifra.
- **Las modificaciones de clausula** no se publican, pero se acotan: subir n tramos cuesta
  `0,40 x (clausula - 1,5 x valor)`, y la clausula y el valor si se ven. Quien tiene la
  clausula por defecto no gasto un euro.
- **Los salarios** estan apagados, y no porque lo diga una captura: en 54 movimientos que
  cubren cuatro jornadas no hay ni un cargo, y la auditoria del libro cuadra al centimo.

Esto no es una limitacion, es lo que lo hace util: si el intervalo de un rival queda por
debajo de la clausula de tu jugador, estas a salvo con certeza. Si lo cruza, no lo estas.

## Como se decide

Lo que decide no es lo bueno que sea un jugador, sino **cuanto mejora tu once**. Un
centrocampista excelente no vale nada si ya tienes cinco mejores; uno mediano en la
posicion en la que vas cojo puede valer mucho. El motor lo calcula por diferencia: optimiza
el once con el jugador y sin el.

Eso se convierte en **euros por punto ganado**, que es la unica cifra con la que se pueden
comparar cosas que no se parecen: un clausulazo de 20M, una puja de 3M y quedarse el
dinero. Y se juzga contra el punto mas barato que ofrece hoy el mercado abierto, porque esa
es la alternativa real para ese mismo dinero.

Para defender vale lo mismo, mirando la plantilla del rival: solo es amenaza quien ademas
saldria ganando. Y cuando no hay tramo que quite el incentivo, la recomendacion no es
resignarse sino subir la clausula para **cobrar mas** por el robo, que a 0,40 por euro sale
a cuenta siempre que el robo sea mas probable que eso.

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
(los datos van a un repositorio privado aparte, no a este)
```

**Principio rector: la IA nunca hace cuentas.** Todo lo numerico se calcula de forma
determinista en `packages/engine` y se le entrega ya resuelto. El modelo se usa para lo que
sabe hacer: interpretar noticias de lesiones, valorar rotaciones y explicar el plan.

### Por que es gratis y siempre esta activo

| Pieza | Servicio | Motivo |
|---|---|---|
| Scheduler | GitHub Actions en repo publico | Minutos ilimitados y gratuitos en repos publicos. |
| Despliegue | GitHub Actions con un token de Cloudflare | Sin instalar wrangler ni iniciar sesion a mano. |
| Base de datos | Un repo git privado aparte | Unos pocos MB por temporada. Nada que se pause ni pida tarjeta. |
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

Primero, para saber por que via va tu cuenta:

```bash
pnpm check:auth tu-email@ejemplo.com
```

Quien entra en Mister con "Continuar con Google" no tiene contrasena nativa, asi que el
login por API no le sirve. Para ese caso, `pnpm capture:session` abre un navegador, te deja
entrar a mano y guarda la sesion resultante, que es lo que usa el scraper. El script valida
la sesion contra Mister antes de dartela, para que no descubras dos dias despues que no
valia. Detalles en [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

Las credenciales viven como **GitHub Actions secrets** y la clave de IA como secreto del
Worker. Nunca se commitean: el repo es publico y `.gitignore` bloquea `.env`, `.dev.vars`,
cookies y sesiones.

## Estado

Funcionando contra la liga real, cuatro veces al dia, desde GitHub Actions.

Lo que esta **comprobado contra datos**, no supuesto:

- **El libro de movimientos.** 54 apuntes auditados contra el saldo que declara Mister
  despues de cada uno: 0 descuadres. La reconstruccion reproduce el saldo propio exacto.
  Ese es el test de que el metodo aplicado a los rivales vale.
- **La direccion de los traspasos.** En el feed no hay etiqueta que diga quien entrega y
  quien recibe: se deduce del orden. Una inversion pondria del reves el saldo de los nueve
  rivales sin dar ningun sintoma, asi que cada ejecucion lo contrasta contra el libro
  propio usando los traspasos que aparecen en ambos sitios. Ultima: 7 coinciden, 0
  discrepan.

Quedan abiertas las incognitas de [docs/INCOGNITAS.md](docs/INCOGNITAS.md) que no se pueden
cerrar observando: si el margen de deuda del 25% sirve para pagar clausulas, la base de
coste de las cesiones y si Mister sigue el horario de verano.

## Reglas de la liga

`docs-liga/` contiene el contrato y el reglamento firmados. `docs/REGLAS.md` es la version
destilada que se le inyecta al asistente como contexto.

## Licencia

MIT. Proyecto personal, sin relacion con Mundo Deportivo ni con Mister Fantasy.
