/**
 * Generador del codigo que va adentro del QR de una entrada.
 *
 * Antes el codigo se derivaba del id del ticket:
 *
 *   code = 'GIANQR-' + ticketId.substring(0, 8).toUpperCase()
 *
 * Eso tenia dos problemas graves:
 *
 *   1. Era deducible. /public/tickets-info devuelve los ticket_ids a
 *      cualquiera que tenga el link de reserva, asi que con el id a la vista
 *      se calculaba el QR de esa entrada. Si el link se reenviaba a un grupo,
 *      cualquiera podia entrar antes que el comprador, y el comprador llegaba
 *      a la puerta y se encontraba con "esta entrada ya fue utilizada".
 *
 *   2. Eran 8 caracteres hex = 32 bits. Poco hasta para adivinar a ciegas.
 *
 * Ahora son 10 bytes al azar (80 bits), sin relacion con el id.
 *
 * Los codigos ya emitidos NO se tocan: se siguen guardando y comparando por
 * la columna qr_code, asi que las entradas vendidas escanean igual que antes.
 * Solo las nuevas nacen con un codigo que no se puede deducir.
 *
 * El prefijo paso de GIANQR- a PRICKETS- con el cambio de nombre. Es cosmetico:
 * el escaneo busca el codigo exacto en la columna qr_code y en ningun lado se
 * valida el prefijo, asi que las entradas vendidas con el prefijo viejo siguen
 * entrando igual. Durante un tiempo un mismo evento va a tener codigos de los
 * dos tipos y esta bien.
 */
const crypto = require('crypto');

function nuevoCodigoQR() {
  return `PRICKETS-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

module.exports = { nuevoCodigoQR };
