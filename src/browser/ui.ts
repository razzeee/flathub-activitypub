const search = document.querySelector<HTMLInputElement>("#app-search");
const count = document.querySelector<HTMLElement>("#app-count");
const empty = document.querySelector<HTMLElement>("#search-empty");
const searchContainer =
  document.querySelector<HTMLElement>(".directory-search");
if (search && count && empty && searchContainer) {
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>("[data-app-search]"),
  );
  searchContainer.hidden = false;
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const card of cards) {
      card.hidden = !(card.dataset.appSearch ?? "")
        .toLocaleLowerCase()
        .includes(query);
      if (!card.hidden) visible++;
    }
    count.textContent = query
      ? visible + (visible === 1 ? " app matches" : " apps match")
      : cards.length +
        " recently indexed " +
        (cards.length === 1 ? "app" : "apps");
    empty.hidden = visible !== 0;
  });
}
if (navigator.clipboard && window.isSecureContext) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-copy-handle]",
  )) {
    const handle = button.dataset.copyHandle;
    const feedback = button.nextElementSibling;
    if (!handle || !feedback) continue;
    button.hidden = false;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(handle);
        feedback.textContent =
          "Handle copied. Paste it into the search on your server.";
      } catch {
        feedback.textContent = "Select the handle above and copy it manually.";
      }
    });
  }
}

export {};
