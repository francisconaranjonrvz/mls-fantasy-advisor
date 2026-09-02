# Incognitas pendientes de confirmar en la app

Ninguna bloquea el desarrollo. Todas afectan a la precision del modelo economico y estan
parametrizadas en `packages/core/src/league.ts`, de modo que se cambian en un unico sitio.

## 1. Salarios (impacto ALTO)

Las capturas de ajustes dicen `Cobrar salarios por jugadores: No`, pero conviven con
`El pago de salarios se ejecuta sobre: el valor de la alineacion`, `Cobrar un 1% sobre el
valor de equipo` y `Ejecutar pago de salarios: al finalizar cada jornada`.

La documentacion oficial describe "Cobrar Salarios" como el interruptor maestro que activa
o desactiva el sistema entero, lo que implica que los otros tres campos estan inertes.

Por que importa: con un once de unos 90M, el 1% son unos 900.000 por jornada, frente a una
bonificacion de 1,0 a 1,5M. Es decir, entre el 60% y el 90% de la bonificacion. Cambia por
completo si conviene acumular valor de plantilla o no.

Estado: `salaries.enabled = false`. El reconstructor de saldos evalua ambas ramas y
ensancha el intervalo de incertidumbre mientras no se confirme.

Como confirmarlo: mirar el feed de balance despues de una jornada y buscar un cargo de
tipo salario.

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

## 5. Forma exacta del feed de rivales (impacto ALTO)

Esta confirmado que `/feed#balance` renderiza `ul.balance-history` con el libro completo
de tus movimientos: tipo, contraparte, fecha, importe con signo y saldo resultante.

Falta confirmar la peticion exacta que devuelve el feed de actividad con los movimientos
de los rivales y sus importes. Se resuelve en dos minutos abriendo DevTools en `/feed` y
mirando la peticion XHR.

Estado: el cliente implementa el parseo del feed propio, ya verificado. El de rivales se
anade en cuanto se confirme la forma de la peticion.

## 6. Bonificacion por punto (impacto MEDIO)

Las capturas dicen `Bonificar por punto de la jornada: No`, pero el valor por defecto de
Mister es 10.000 por punto. Merece la pena confirmar que esta efectivamente desactivada,
porque seria un ingreso ligado al rendimiento que cambiaria el balance de todos.

Estado: `bonusPerPoint = 0`.
