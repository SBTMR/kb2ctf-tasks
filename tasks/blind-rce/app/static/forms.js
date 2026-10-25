const form = document.querySelector("form[data-api]");
const output = document.getElementById("result");

form.addEventListener("submit", async function(event) {
  event.preventDefault();
  const ip = form.elements.ip.value;
  if (!ip) return;

  output.textContent = "Отправка запроса…";
  try {
    const response = await fetch(form.dataset.api, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ip: ip})
    });
    const data = await response.json();
    output.textContent = data.message;
  } catch (error) {
    output.textContent = `Ошибка: ${error}`;
  }
});
