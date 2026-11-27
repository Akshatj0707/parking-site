/*
 * The invoice page. The server writes the whole invoice; this file only turns on the print button
 * when there is an invoice on the page (the "genuine / not a match" answer has nothing to print).
 */
(function () {
  'use strict';

  const actions = document.getElementById('invoice-actions');
  const print = document.getElementById('invoice-print');
  if (!actions || !print || !document.querySelector('.invoice')) return;
  actions.hidden = false;
  print.addEventListener('click', () => window.print());
})();
