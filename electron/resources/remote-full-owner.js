const email = document.querySelector("#email"), code = document.querySelector("#code"), status = document.querySelector("#status");
window.ownerEnrollment.context().then(c => { document.querySelector("#target").textContent = `${c.origin} · ${c.environmentId}`; });
let busy = false;
async function run(action) { if (busy) return; busy = true; try { const r = await action(); status.textContent = r.error || (r.sent ? "Code sent. Enter it here only." : "Verified."); } catch { status.textContent = "Sign-in unavailable."; } finally { busy = false; } }
document.querySelector("#send").onclick = () => run(() => window.ownerEnrollment.request(email.value));
document.querySelector("form").onsubmit = event => { event.preventDefault(); const value = code.value; code.value = ""; void run(() => window.ownerEnrollment.verify(email.value, value)); };
