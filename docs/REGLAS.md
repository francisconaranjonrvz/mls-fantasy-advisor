# Reglas de la liga MLS (Malos Ligando Siempre) - Temporada 26-27

Version destilada del contrato y del reglamento que hay en `docs-liga/`. Es el
contexto que se le inyecta al asistente. Ante cualquier discrepancia mandan los
PDF originales, y dentro de ellos manda el contrato sobre el reglamento.

## Como se gana

- 10 participantes, 38 jornadas, plataforma Mister.
- **Gana quien mas puntos ACUMULE al final de las 38 jornadas.** No gana quien
  mas dinero tenga ni quien mas valor de equipo acumule: el dinero solo es un
  medio para puntuar.
- Puntuacion efectiva = puntos que muestra Mister menos los puntos de sancion
  acumulados. El registro de sanciones vive en la descripcion del grupo de
  WhatsApp.

## Dinero real

- Cuota: 1 EUR por participante y jornada. La jornada 1 se paga aunque no se
  juegue. Maximo teorico por participante: 38 EUR.
- **El ganador de cada jornada queda exento de pagar ese euro.** Ganar una
  jornada vale 1 EUR real.
- Bote teorico: 380 - 38 = **342 EUR**. Reparto: 60% al primero (205,20),
  25% al segundo (85,50) y 15% al tercero (51,30).
- Pago mensual, antes del dia 5 del mes siguiente. Una jornada cuenta en el mes
  en que EMPIEZA.
- Impago: no se puede disputar una jornada del mes siguiente, elegida por el
  sancionado, con 0 puntos. Al segundo impago hay que pagar de golpe todo lo
  pendiente y ya no se generan nuevas exenciones.
- Desempate final: 1) mas jornadas ganadas, 2) criterio de Mister, 3) acuerdo
  entre los afectados.

## Ajustes de la liga en Mister

- Sistema de puntuacion: **SofaScore**. Capitan: desactivado.
- Reparto inicial: 15 jugadores aleatorios + 50M, descontando el valor de esa
  plantilla. Es decir, todos empezaron con 50M entre plantilla y caja.
- Maximo 24 jugadores por equipo. Sin limite de jugadores del mismo club.
- **Ver el saldo de los rivales: NO.** De ahi que haya que reconstruirlo.
- Deuda maxima: saldo actual + 25% del valor del equipo.
- Velocidad de mercado: Normal con oferta adicional. La compraventa y la
  rotacion del mercado ocurren SOLO a las 05:00 (UTC+1). Las 17:00 son
  unicamente una oferta extra de Mister sobre jugadores ya listados.
- Maximo 20 jugadores en el mercado, y solo entran nuevos en proporcion a los
  que se compran.
- Cesiones permitidas, coste minimo 10% del valor. No se puede ofertar a otro
  miembro por debajo del valor de mercado.
- **Compras por creditos: todas desactivadas.** Eso incluye la rescision de
  contrato (despido), asi que NO existe la via de convertir un jugador en
  dinero al instante. La unica forma de hacer caja es vender y esperar al
  ciclo de las 05:00, o bajar clausulas.
- Bonificaciones: solo por clasificacion de jornada, y con **escalera
  invertida**: 1o 1,00M, 2o 1,05M, 3o 1,10M, 4o 1,15M, 5o 1,20M, 6o 1,30M,
  7o 1,35M, 8o 1,40M, 9o 1,45M, 10o 1,50M. Ni bonus por punto, ni por gol, ni
  por once ideal.
- Quiniela 1X2 activada: 25.000 por acierto.

## Clausulas

- Clausula por defecto = 1,5 x max(precio de compra, valor de mercado). Suelo
  de 1M si el valor cae a 666.666 o menos.
- Tres tramos de subida: +100%, +150% y +200%, que dejan la clausula en 2,0x,
  2,5x y 3,0x la base. Coste = 0,2 x base x numero de tramo.
- **El tipo de cambio es constante: 0,40 EUR por cada euro de proteccion, en
  los tres tramos.** Ningun tramo es mas eficiente que otro.
- Bajar una clausula devuelve el 50% de lo invertido. **Ojo con el bloqueo de
  48 horas: se aplica solo despues de BAJAR una clausula, e impide volver a
  subirla durante ese tiempo. Subir una clausula no bloquea nada** y se puede
  seguir subiendo de tramo cuando se quiera.
- Una clausula subida SUBE si el jugador se revaloriza, pero se CONGELA si se
  devalua. Solo compensa proteger a quien esperas que suba.
- Blindaje de 7 dias para los recien fichados.
- Maximo 3 fichajes por clausula al dia, y maximo 3 robos recibidos al dia.
- Las clausulas se bloquean en las 24 horas previas al inicio de la jornada.

## Norma propia de la liga: el cambio durante la jornada

Solo se permite **un** cambio por jornada, y con estas condiciones:

1. El jugador que sale debe estar en el once y no haber disputado aun su
   partido (por no tener minutos o porque su partido sea posterior).
2. El jugador que entra no puede haber disputado aun su partido, y **tenia que
   estar ya en el equipo antes de empezar la jornada**.
3. Tambien vale para rellenar un hueco vacio del once.
4. Solo uno por jornada.

Conocer una alineacion, una lesion o una convocatoria no da derecho a mas
cambios. Incumplirlo supone recalcular la jornada como si el cambio no se
hubiera hecho, mas **2 puntos de penalizacion**.

## Conductas prohibidas

- Operaciones entre participantes cuyo fin sea transferir valor de forma
  artificial: comprar muy por encima o vender muy por debajo del valor para
  beneficiar a alguien, operaciones repetidas sin sentido deportivo, u
  operaciones pensadas para mejorar condiciones de clausula o abusar del
  blindaje de 7 dias.
- Acuerdos para dejar de competir, beneficiar a alguien a cambio de algo, o
  coordinarse para perjudicar a un tercero.
- Aprovechar deliberadamente un fallo de la plataforma.
- Compartir o usar la cuenta de otro.

Que algo sea tecnicamente posible dentro de Mister **no implica que este
permitido**. La autoridad reguladora (Alvaro Ramirez Acuna) decide sobre lo no
previsto. En caso de duda razonable prevalece la interpretacion mas favorable
al participante.

Sanciones de referencia: leves entre 100k y 1M de multa en el juego; graves
entre 1M y 10M, anulacion de la accion o 0 puntos en la jornada; muy graves,
votacion de expulsion.

## Personas

- Autoridad reguladora: Alvaro Ramirez Acuna.
- Gestion del bote: Jose Miguel Quintela Gonzalez.

## Que significa esto para la estrategia

- La escalera de bonificaciones esta invertida: el ultimo cobra 500k mas que el
  primero cada jornada, unos 19M a lo largo de la temporada. El dinero converge
  solo, asi que acumular caja es malo. Conviene convertirla pronto en valor de
  plantilla y en proteccion, mientras tu poder de compra relativo es mayor.
- Con 20 huecos de mercado y 10 participantes, el mercado abierto casi nunca
  ofrece nada bueno. El canal real para mejorar es el clausulazo.
- Sin despido disponible, quedarse sin liquidez es peligroso: recuperar dinero
  exige esperar al ciclo de las 05:00 o bajar clausulas, y bajar una clausula
  bloquea volver a subirla 48 horas.
- Empezar una jornada en negativo significa **0 puntos**. Es la unica
  restriccion verdaderamente dura del juego.
