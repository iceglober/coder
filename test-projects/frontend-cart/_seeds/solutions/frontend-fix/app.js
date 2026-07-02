// Minimal storefront cart. Prices are in cents; a discount code takes a whole-number percent off the
// running subtotal. No framework, no build step — served as-is.
const CATALOG = {
  WIDGET: { name: "Widget", cents: 1000 },
  GADGET: { name: "Gadget", cents: 2500 },
};
const CODES = { SAVE10: 10, SAVE25: 25 }; // percent off

const cart = [];
let appliedPct = 0;

function formatCents(c) {
  return "$" + (c / 100).toFixed(2);
}

function subtotalCents() {
  return cart.reduce((sum, item) => sum + item.cents, 0);
}

// pct is a whole-number percent: 10 means 10% off.
function applyDiscount(cents, pct) {
  return Math.round(cents * (1 - pct / 100));
}

function totalCents() {
  return applyDiscount(subtotalCents(), appliedPct);
}

function render() {
  document.getElementById("count").textContent = String(cart.length);
  document.getElementById("subtotal").textContent = formatCents(subtotalCents());
  document.getElementById("total").textContent = formatCents(totalCents());
  document.getElementById("applied").textContent = appliedPct ? `(${appliedPct}% off)` : "";
}

for (const btn of document.querySelectorAll("[data-add]")) {
  btn.addEventListener("click", () => {
    const sku = btn.getAttribute("data-add");
    cart.push({ sku, ...CATALOG[sku] });
    render();
  });
}

document.getElementById("apply").addEventListener("click", () => {
  const code = document.getElementById("code").value.trim().toUpperCase();
  appliedPct = CODES[code] ?? 0;
  render();
});

render();
