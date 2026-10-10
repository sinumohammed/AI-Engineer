import { useEffect, useState } from "react";
import { App as AntApp, theme } from "antd";
import { XProvider } from "@ant-design/x";
import App from "./App.jsx";

// Phase 10 UI: Ant Design + Ant Design X (components made for AI chat).
// Light or dark follows the device unless the user picks one in the menu;
// the choice is remembered in this browser.
const BRAND = "#6d5ff5";

function readStored() {
  try {
    return localStorage.getItem("themeMode") ?? "system";
  } catch {
    return "system";
  }
}

function useSystemDark() {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

export default function Root() {
  const [themeMode, setThemeModeState] = useState(readStored);
  const systemDark = useSystemDark();
  const isDark = themeMode === "dark" || (themeMode === "system" && systemDark);

  function setThemeMode(mode) {
    setThemeModeState(mode);
    try {
      localStorage.setItem("themeMode", mode);
    } catch {
      // storage blocked: the choice lasts until the page closes
    }
  }

  // The browser/phone status bar follows the app's background.
  useEffect(() => {
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", isDark ? "#0d0d14" : "#f7f7fb"));
  }, [isDark]);

  return (
    <XProvider
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: BRAND,
          colorInfo: BRAND,
          borderRadius: 12,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", Roboto, "Noto Sans", "Noto Sans Malayalam", "Noto Sans Devanagari", sans-serif',
          colorBgLayout: isDark ? "#0d0d14" : "#f7f7fb",
          colorBgContainer: isDark ? "#16161f" : "#ffffff",
        },
      }}
    >
      <AntApp>
        <App themeMode={themeMode} setThemeMode={setThemeMode} isDark={isDark} />
      </AntApp>
    </XProvider>
  );
}
