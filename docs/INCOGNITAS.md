# Incognitas pendientes de confirmar en la app

Ninguna bloquea el desarrollo. Todas afectan a la precision del modelo economico y estan
parametrizadas en `packages/core/src/league.ts`, de modo que se cambian en un unico sitio.

## 1. Salarios (RESUELTO: estan desactivados)

Las capturas de ajustes decian `Cobrar salarios por jugadores: No`, pero convivian con
`El pago de salarios se ejecuta sobre: el valor de la alineacion`, `Cobrar un 1% sobre el
valor de equipo` y `Ejecutar pago de salarios: al finalizar cada jornada`, asi que no
quedaba claro cual mandaba.

**Lo dice el libro de movimientos, y de dos formas independientes.** En 54 apuntes que
cubren cuatro jornadas no hay ni un solo cargo de salario. Y, mas concluyente: la
auditoria del libro contra su propio saldo resultante cuadra al centimo en los 54. Si
hubiera un cargo de ~900.000 por jornada sin modelar, no cuadraria.

Estado: `salaries.enabled = false`, confirmado contra datos reales.

## 2. Sirve la deuda del 25% para pagar clausulas? (impacto ALTO)

La puja maxima es el saldo mas el 25% del valor del equipo. No he podido confirmar en
ninguna fuente de Mister si ese margen se puede usar para pagar una clausula o solo para
pujar en el mercado.

Por que importa: determina la capacidad real de raid, tanto la tuya como la que
atribuimos a los rivales al calcular el riesgo de que te roben.

Estado: el motor asume que si aplica. Es la hipotesis conservadora, porque sobreestima la
amenaza rival, que es el error seguro.

## 3. Base de coste de las cesiones (impacto BAJO)

El texto oficial habla del 10% del valor de mercado multiplicado por el numero de semanas
o dias, sin aclarar que multiplicador corresponde a cada opcion de duracion.

Al 10% por dia, ceder a un jugador de 20M una semana costaria 14M y las cesiones son
economicamente inviables. Al 10% por semana son 2M y si tienen sentido.

Estado: las cesiones no se modelan como canal de fichaje. Si se documenta el efecto
colateral util: un jugador cedido no puede ser fichado por nadie, asi que ceder es una
forma de blindar a un jugador cobrando por ello.

## 4. Horario de verano (impacto MEDIO)

Los horarios oficiales de Mister se publican en UTC+1. No he podido confirmar si se
desplazan con el horario de verano espanol o si se mantienen fijos todo el ano.

Estado: el workflow de ingesta corre a las 04:20, 05:20, 16:20 y 17:20 UTC y es
idempotente, de modo que cubre ambas interpretaciones. Correr de mas es gratis.

## 5. Movimientos de los rivales (RESUELTO)

El libro propio NO esta en el HTML de `/feed`, como sugeria la documentacion de la
comunidad: viene en el JSON de `/ajax/sw/balance`, junto al saldo, con el importe sin
formatear y la marca de tiempo. Mejor fuente que raspar marcado.

Los movimientos de los rivales salen del feed de actividad, de las tarjetas
`.card-transfer`. Ahi no hay etiqueta que diga quien entrega y quien recibe: se deduce del
orden en que aparecen los dos managers. Como una inversion de ese criterio pondria del
reves el saldo de los diez rivales sin dar ningun sintoma, la ingesta lo **contrasta en
cada ejecucion** contra el libro propio, que si es autoritativo, usando los traspasos que
aparecen en ambos sitios. Ultima ejecucion: 7 coinciden, 0 discrepan.

Lo que el feed sigue sin publicar son las bonificaciones y las modificaciones de clausula
de los rivales, asi que su historial nunca es completo y el intervalo lo refleja.

## 6. Bonificacion por punto (impacto MEDIO)

Las capturas dicen `Bonificar por punto de la jornada: No`, pero el valor por defecto de
Mister es 10.000 por punto. Merece la pena confirmar que esta efectivamente desactivada,
porque seria un ingreso ligado al rendimiento que cambiaria el balance de todos.

Estado: `bonusPerPoint = 0`.

## 7. Longevidad de la sesion capturada (impacto ALTO)

Esta es la incognita que decide si el sistema aguanta nueve meses solo, y la
evidencia disponible es mas floja de lo que parece a primera vista.

**Lo que si esta comprobado:**

- El `refresh-token` es un JWT con `exp` exactamente 100 anos despues de su
  emision, y el payload declara `id_token_lifetime_in_min: "5"`. No caduca por
  su propia declaracion.
- El unico proyecto publico que hace esto mismo en produccion
  (`IgnacioGarijo/elcerdo`) se autentica **solo con la cookie**, con
  `MISTER_EMAIL` y `MISTER_PASSWORD` vacios en sus ejecuciones.
- No hay senal de bloqueo por IP de datacenter: sus ejecuciones completan
  ~500 peticiones autenticadas en 90-180 s desde GitHub Actions sin un solo
  429, 403 ni captcha.

**Lo que NO esta comprobado, y conviene no dar por hecho:**

- **Ese proyecto lleva 6 ejecuciones en 6 dias, no meses.** Es evidencia de que
  el mecanismo funciona hoy, no de que aguante una temporada.
- Que el `exp` a 100 anos signifique que la sesion no muere. El campo `refresh`
  del payload es un identificador opaco del lado servidor: un TTL de
  inactividad o una purga del almacen de sesiones la invalidarian sin que nada
  del token lo delate.
- Que el `refresh-token` no rote. La evidencia se reduce a un unico salto de
  24 horas reutilizando el mismo valor. Si Mister rotase, habria que reescribir
  el secret en cada ejecucion.
- Que la ausencia de bloqueos transfiera a este proyecto. Ese scraper conduce un
  Chromium real con Playwright; este cliente es `fetch` pelado, con otra huella
  TLS y sin ejecutar JavaScript. La comparacion no es directa.

**Consecuencia practica:** trata la recaptura de sesion como un evento probable,
no remoto. El sistema esta preparado: detecta la sesion muerta y dice
exactamente que hacer.

## 8. Que jornada es (parcialmente resuelto)

El rotulo de la pagina y los datos no dicen lo mismo. La pagina pone "JORNADA 4"; los
jugadores, con `puntos / media`, dicen que se han disputado 4. Es decir, el rotulo se
refiere a la jornada en curso y no a las cerradas.

Se resuelve deduciendolo de los datos, que es la fuente mas fiable de las dos, y avisando
cuando discrepan en vez de elegir en silencio. Importa porque de esa cifra cuelgan todas
las medias por jornada y la proyeccion de lo que queda de temporada, y equivocarse en una
jornada de cuatro es un error del 25%.

Queda un cabo suelto: `/ajax/sw/progression` lista las jornadas puntuadas como
`J2, J3, J4, J6`. Faltan la primera y la quinta y aparece una sexta. Si esa numeracion es
la de LaLiga y no la de la liga privada, quedan 32 jornadas por jugar y no 34, y la
proyeccion esta un 6% alta.

## 9. Como saber si tu cuenta admite contrasena (resuelto)

Mister expone un endpoint **publico y sin autenticacion** que dice que metodos
de acceso admite una cuenta. Comprobado contra produccion:

```bash
curl "https://mister.mundodeportivo.com/api2/users/auth-methods?email=TU_EMAIL"
```

- `{"supportedAuthMethods":["email"]}` -> la cuenta admite contrasena.
- Si aparece `"google"` y no `"email"` -> solo OAuth, hay que capturar sesion.
- `404 [{"message":"Usuario no encontrado"}]` -> ese email no esta registrado.

No tiene efectos secundarios: solo consulta. Es la forma mas rapida de saber por
que via hay que ir.
