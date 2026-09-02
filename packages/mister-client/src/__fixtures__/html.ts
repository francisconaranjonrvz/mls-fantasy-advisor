/**
 * Fragmentos HTML con la forma que devuelve Mister, reducidos a lo que
 * consumen los parsers. Sirven para detectar en CI que un cambio de
 * selectores rompe la ingesta, sin tener que llamar a la API real.
 */

export const TEAM_HTML = `
<div class="gameweek" data-gwid="6"></div>
<ul class="player-list">
  <li class="player-row">
    <div class="player-avatar" data-id_player="12900"></div>
    <a class="team-logo"><img class="team-logo" src="/rma.png"></a>
    <div class="player-position" data-position="4"></div>
    <div class="name">Vinicius Junior</div>
    <div class="underName">18.400.000 <span class="value-arrow green"></span></div>
    <div class="points">54</div>
    <div class="streak"><span class="bg--good"></span><span class="bg--bad"></span></div>
  </li>
  <li class="player-row">
    <div class="player-avatar" data-id_player="11700"></div>
    <a class="team-logo"><img class="team-logo" src="/fcb.png"></a>
    <div class="player-position" data-position="2"></div>
    <div class="name">Ferran Torres</div>
    <div class="underName">7.150.000 <span class="value-arrow red"></span></div>
    <div class="points">21</div>
    <svg><use href="#injury"></use></svg>
  </li>
  <li class="player-row">
    <div class="player-avatar" data-id_player="99001"></div>
    <div class="player-position" data-position="1"></div>
    <div class="name">Portero Que Se Fue</div>
    <div class="underName">900.000</div>
    <div class="points">0</div>
    <svg><use href="#cross"></use></svg>
  </li>
</ul>`

export const MARKET_HTML = `
<ul id="list-on-sale">
  <li data-price="8400000" data-position="3" data-owner="0">
    <div class="player-pic" data-id_player="10024"><img src="/a.png"></div>
    <div class="name">Mauro Arambarri</div>
    <div class="points">31</div>
    <button class="btn-bid" data-id_market="m-771" data-active="1"></button>
  </li>
  <li data-price="21000000" data-position="4" data-owner="4412">
    <div class="player-pic" data-id_player="12902"><img src="/b.png"></div>
    <div class="name">Raul de Tomas</div>
    <div class="points">40</div>
    <button class="btn-bid" data-id_market="m-772" data-active="1"></button>
  </li>
</ul>`

export const STANDINGS_HTML = `
<table>
  <tr><td><a href="users/4410/olivito">Olivito</a></td></tr>
  <tr><td><a href="/users/4411/el-mister-loco">El Mister Loco</a></td></tr>
  <tr><td><a href="users/4412/paquito">Paquito</a></td></tr>
  <tr><td><a href="users/4412/paquito">Paquito otra vez</a></td></tr>
</table>`

export const BALANCE_HTML = `
<ul class="balance-history">
  <li>
    <div class="type">Purchase</div>
    <div class="reason">Lamine Yamal to Mister</div>
    <div class="date" title="12/09/2026 - 05:00">12 sep</div>
    <div class="amount">-14.200.000</div>
    <div class="balance">3.100.000</div>
  </li>
  <li>
    <div class="type">Buyout sale</div>
    <div class="reason">Pedri to Paquito</div>
    <div class="date" title="14/09/2026 - 05:00">14 sep</div>
    <div class="amount">24.000.000</div>
    <div class="balance">27.100.000</div>
  </li>
  <li>
    <div class="type">Bonificacion</div>
    <div class="reason">Jornada 5</div>
    <div class="date" title="15/09/2026 - 09:00">15 sep</div>
    <div class="amount">1.300.000</div>
    <div class="balance">28.400.000</div>
  </li>
  <li>
    <div class="type">Penalizacion</div>
    <div class="reason">Modificacion de clausula (150%) de Jorge de Frutos</div>
    <div class="date" title="16/09/2026 - 11:30">16 sep</div>
    <div class="amount">-2.400.000</div>
    <div class="balance">26.000.000</div>
  </li>
</ul>`

export const MARKET_PAGE_WITH_AUTH = `
<html><head><script>
window.__CFG = {"lang":"es","auth":"6baca5339d20a40b459ad851692e643f","id_competition":"1263883"};
</script></head><body></body></html>`
