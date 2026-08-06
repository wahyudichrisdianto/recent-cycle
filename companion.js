function resolveTheme(value) {
  if (value === "light" || value === "dark") {
    return value;
  }
  return "system";
}

if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get(["theme"], (res) => {
    document.documentElement.dataset.theme = resolveTheme(res?.theme);
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.theme) {
      document.documentElement.dataset.theme = resolveTheme(changes.theme.newValue);
    }
  });
}