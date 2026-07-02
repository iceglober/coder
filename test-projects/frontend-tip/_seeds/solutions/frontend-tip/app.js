// Dinner receipt: render the bill, the tip, and the grand total. Amounts are in cents; the tip is a
// whole-number percent of the bill. Rendered once on load — there is no interaction.
const BILL_CENTS = 5000; // $50.00
const TIP_PERCENT = 18; // 18%

function formatCents(c) {
  return "$" + (c / 100).toFixed(2);
}

// pct is a whole-number percent: 18 means 18% of the bill.
function tipCents(billCents, pct) {
  return Math.round((billCents * pct) / 100);
}

function render() {
  const tip = tipCents(BILL_CENTS, TIP_PERCENT);
  document.getElementById("bill").textContent = formatCents(BILL_CENTS);
  document.getElementById("pct").textContent = TIP_PERCENT + "%";
  document.getElementById("tip").textContent = formatCents(tip);
  document.getElementById("total").textContent = formatCents(BILL_CENTS + tip);
}

render();
