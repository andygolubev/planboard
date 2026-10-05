// Shared by the Boards page and every board. Run in <head> to avoid a theme flash.
(() => {
  const key = "pb:theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = null;

  function readPreference() {
    try {
      const saved = localStorage.getItem(key);
      return saved === "light" || saved === "dark" ? saved : null;
    } catch {
      return preference;
    }
  }

  function updateButton() {
    const button = document.getElementById("themeToggle");
    if (!button) return;
    const dark = document.documentElement.dataset.theme === "dark";
    button.textContent = dark ? "☀ Light" : "☾ Dark";
    button.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
    button.title = `Switch to ${dark ? "light" : "dark"} theme`;
  }

  function applyTheme() {
    const theme = preference || (system.matches ? "dark" : "light");
    const changed = document.documentElement.dataset.theme !== theme;
    document.documentElement.dataset.theme = theme;
    updateButton();
    if (changed) window.dispatchEvent(new Event("planboard:themechange"));
  }

  function syncPreference() {
    preference = readPreference();
    applyTheme();
  }

  syncPreference();
  document.addEventListener("DOMContentLoaded", () => {
    updateButton();
    document.getElementById("themeToggle")?.addEventListener("click", () => {
      preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(key, preference); } catch {}
      applyTheme();
    });
  }, { once: true });
  system.addEventListener("change", () => {
    if (!preference) applyTheme();
  });
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) syncPreference();
  });
  window.addEventListener("pageshow", syncPreference);
})();
