import { Suspense, lazy, useEffect, useState } from "react";
import { App as AntApp, Button, theme } from "antd";
import { XProvider } from "@ant-design/x";
import App from "./App.jsx";

// Phase 10e: #/command opens the Command Center, loaded only when opened.
const CommandCenter = lazy(() => import("./CommandCenter.jsx"));
function useHash() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

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

// A new version was deployed: the service worker (vite-plugin-pwa, autoUpdate) has it, but this page
// still runs the old one until it reloads - so after a deploy the Command Center looked unchanged.
// Says so with a Reload button; never reloads by itself (a question or a voice conversation may be going).
// Also asks for updates when the page comes back into view, for pages left open for hours.
function useNewVersion() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return undefined;
    const hadOne = !!sw.controller; // the first install also "changes" the controller - not an update
    const onChange = () => hadOne && setReady(true);
    const check = () => document.visibilityState === "visible" && sw.getRegistration().then((r) => r?.update()).catch(() => {});
    sw.addEventListener("controllerchange", onChange);
    document.addEventListener("visibilitychange", check);
    return () => {
      sw.removeEventListener("controllerchange", onChange);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return ready;
}

export default function Root() {
  const newVersion = useNewVersion();
  const [themeMode, setThemeModeState] = useState(readStored);
  const systemDark = useSystemDark();
  const hash = useHash();
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
        {newVersion && (
          <div className="new-version" role="status">
            A new version is ready.
            <Button size="small" type="primary" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        )}
        {hash.startsWith("#/command") ? (
          <Suspense fallback={null}>
            <CommandCenter isDark={isDark} />
          </Suspense>
        ) : (
          <App themeMode={themeMode} setThemeMode={setThemeMode} isDark={isDark} />
        )}
      </AntApp>
    </XProvider>
  );
}
