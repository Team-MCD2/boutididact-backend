/**
 * Service d'impression ESC/POS.
 *  - checkOnline : ping TCP sur le port 9100
 *  - printTicket : composition d'un ticket conforme aux usages français
 *      (en-tête commerce, N° ticket, date/heure, lignes, TVA si fournie,
 *      total TTC, paiement, mentions légales, coupe).
 */
const net = require('net');
const ThermalPrinter = require('node-thermal-printer').printer;
const PrinterTypes = require('node-thermal-printer').types;
const config = require('../config/env');

const checkOnline = (ip = config.printer.ip, port = config.printer.port, timeout = 2000) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, ip);
  });

const buildPrinter = (overrides = {}) => {
  const ip = overrides.printerIp || config.printer.ip;
  const type = (overrides.type || config.printer.type) === 'STAR' ? PrinterTypes.STAR : PrinterTypes.EPSON;
  return new ThermalPrinter({
    type,
    interface: `tcp://${ip}`,
    characterSet: 'PC858_EURO',
    removeSpecialCharacters: false,
    width: overrides.width || config.printer.width,
    options: { timeout: 5000 },
  });
};

const padCenter = (txt, w) => {
  if (txt.length >= w) return txt.slice(0, w);
  const left = Math.floor((w - txt.length) / 2);
  return ' '.repeat(left) + txt + ' '.repeat(w - txt.length - left);
};

/**
 * @param {object} ticket
 *   - ticketId      : string (N° séquentiel)
 *   - saleId        : string|number (ID Hiboutik si dispo)
 *   - items         : [{ name, quantity, price (TTC unitaire) }]
 *   - total         : nombre TTC
 *   - taxBreakdown  : [{ rate: 20, base: 12.50, tax: 2.50 }] (optionnel)
 *   - payment       : libellé paiement (CB / Espèces / ...)
 *   - shop          : { name, address, siret, tva, footer }
 *   - printerIp     : override
 *   - openDrawer    : bool
 */
const printTicket = async (ticket = {}) => {
  const printer = buildPrinter({ printerIp: ticket.printerIp });
  const w = config.printer.width;
  const shop = { ...config.shop, ...(ticket.shop || {}) };

  // ---- En-tête commerce ----
  printer.alignCenter();
  printer.bold(true);
  printer.setTextSize(1, 1);
  printer.println(shop.name || 'COMMERCE');
  printer.bold(false);
  printer.setTextSize(0, 0);
  if (shop.address) printer.println(shop.address);
  if (shop.siret) printer.println(`SIRET : ${shop.siret}`);
  if (shop.tva) printer.println(`TVA : ${shop.tva}`);
  printer.drawLine();

  // ---- Métadonnées ticket ----
  printer.alignLeft();
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR');
  const timeStr = now.toLocaleTimeString('fr-FR');
  printer.leftRight(`Ticket : ${ticket.ticketId || `T-${Date.now()}`}`, dateStr);
  if (ticket.saleId) printer.leftRight(`Vente Hiboutik : #${ticket.saleId}`, timeStr);
  else printer.leftRight('', timeStr);
  printer.drawLine();

  // ---- Lignes articles ----
  printer.tableCustom([
    { text: 'Article', align: 'LEFT', width: 0.55 },
    { text: 'Qté', align: 'CENTER', width: 0.15 },
    { text: 'Total', align: 'RIGHT', width: 0.30 },
  ]);
  printer.drawLine();

  (ticket.items || []).forEach((item) => {
    const name = String(item.name || '').slice(0, Math.floor(w * 0.55) - 1);
    const qty = Number(item.quantity) || 1;
    const unit = Number(item.price) || 0;
    const lineTotal = (unit * qty).toFixed(2);
    printer.tableCustom([
      { text: name, align: 'LEFT', width: 0.55 },
      { text: String(qty), align: 'CENTER', width: 0.15 },
      { text: `${lineTotal} EUR`, align: 'RIGHT', width: 0.30 },
    ]);
    if (qty > 1) {
      printer.println(`   ${unit.toFixed(2)} EUR / unité`);
    }
  });

  printer.drawLine();

  // ---- Total TTC ----
  printer.alignRight();
  printer.bold(true);
  printer.setTextSize(1, 1);
  printer.println(`TOTAL TTC : ${Number(ticket.total).toFixed(2)} EUR`);
  printer.bold(false);
  printer.setTextSize(0, 0);

  // ---- Détail TVA si fourni ----
  if (Array.isArray(ticket.taxBreakdown) && ticket.taxBreakdown.length) {
    printer.alignLeft();
    printer.println('Détail TVA :');
    ticket.taxBreakdown.forEach((t) => {
      printer.println(
        `  TVA ${t.rate}%  HT ${Number(t.base).toFixed(2)}  TVA ${Number(t.tax).toFixed(2)}`
      );
    });
  }

  // ---- Paiement ----
  printer.alignLeft();
  printer.println(`Paiement : ${ticket.payment || 'Espèces'}`);
  printer.drawLine();

  // ---- Pied de ticket ----
  printer.alignCenter();
  if (shop.footer) printer.println(shop.footer);
  printer.println(padCenter('Ticket non valable comme facture', w));
  printer.println(padCenter(`Édité le ${dateStr} à ${timeStr}`, w));

  printer.cut();
  if (ticket.openDrawer ?? config.printer.openDrawer) {
    printer.openCashDrawer();
  }

  const ok = await printer.execute();
  if (!ok) {
    throw new Error("L'envoi des données ESC/POS à l'imprimante a échoué.");
  }
  return true;
};

module.exports = { checkOnline, printTicket };
