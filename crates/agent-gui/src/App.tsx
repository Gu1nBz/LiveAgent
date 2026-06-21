import type { Context } from "@earendil-works/pi-ai";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CronPromptRunner } from "./components/cron/CronPromptRunner";
import { MemoryOrganizerRunner } from "./components/memory/MemoryOrganizerRunner";
import { WindowsTitleBar } from "./components/WindowsTitleBar";
import { LocaleContext, t as translate } from "./i18n";
import { type AppUpdateController, useAppUpdateController } from "./lib/appUpdates";
import {
  type AppSettings,
  getDefaultSettings,
  normalizeSettings,
  resolveWorkspaceProjects,
} from "./lib/settings";
import {
  loadPersistedSettingsWithDefaults,
  persistSettings,
  publishGatewaySettingsSync,
  type SettingsSaveState,
} from "./lib/settings/storage";
import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncPayload,
  type GatewaySettingsSyncPayload,
} from "./lib/settings/sync";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { SectionId } from "./pages/settings/types";

function getDefaultContext(): Context {
  return {
    messages: [],
  };
}

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error ?? "").trim();
  return text || fallback;
}

const GATEWAY_SETTINGS_SYNC_EVENT = "gateway:settings-sync";

function AppChrome(props: { children: ReactNode; appUpdate?: AppUpdateController }) {
  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden bg-background"
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <WindowsTitleBar appUpdate={props.appUpdate} />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">{props.children}</div>
    </div>
  );
}

function hasSettingsSyncChanged(prev: AppSettings, next: AppSettings) {
  return (
    JSON.stringify(buildGatewaySettingsSyncPayload(prev)) !==
    JSON.stringify(buildGatewaySettingsSyncPayload(next))
  );
}

function hasSensitiveSettingsUpdates(settings: AppSettings) {
  return (
    settings.customProviders.some((provider) => provider.apiKey.trim().length > 0) ||
    settings.ssh.hosts.some(
      (host) => host.password.trim().length > 0 || host.privateKey.trim().length > 0,
    )
  );
}

function hasSensitiveSettingsUpdatesPayload(payload: unknown) {
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { providerApiKeyUpdates?: unknown; sshSecretUpdates?: unknown })
      : {};
  const providerUpdates = source.providerApiKeyUpdates;
  if (
    providerUpdates &&
    typeof providerUpdates === "object" &&
    !Array.isArray(providerUpdates) &&
    Object.values(providerUpdates).some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    return true;
  }
  const sshUpdates = source.sshSecretUpdates;
  return Boolean(
    sshUpdates &&
      typeof sshUpdates === "object" &&
      !Array.isArray(sshUpdates) &&
      Object.values(sshUpdates).some((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const update = value as { password?: unknown; privateKey?: unknown };
        return (
          (typeof update.password === "string" && update.password.trim().length > 0) ||
          (typeof update.privateKey === "string" && update.privateKey.trim().length > 0)
        );
      }),
  );
}

function applyRuntimeSystemDefaults(settings: AppSettings, defaultWorkdir: string): AppSettings {
  const normalizedDefaultWorkdir = defaultWorkdir.trim();
  const system =
    !normalizedDefaultWorkdir || settings.system.workdir.trim()
      ? settings.system
      : {
          ...settings.system,
          workdir: normalizedDefaultWorkdir,
        };
  return normalizeSettings({
    ...settings,
    system: resolveWorkspaceProjects(system, normalizedDefaultWorkdir),
  });
}

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [settingsReady, setSettingsReady] = useState(false);
  const [settings, setSettingsState] = useState<AppSettings>(() => getDefaultSettings());
  const [settingsSaveState, setSettingsSaveState] = useState<SettingsSaveState>({
    status: "idle",
  });
  const [context, setContext] = useState<Context>(() => getDefaultContext());
  const [overlay, setOverlay] = useState<"closed" | "entering" | "open" | "leaving">("closed");

  const saveSequenceRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const defaultWorkdirRef = useRef("");

  // 同步主题 class 到 <html> 根节点
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [settings.theme]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSettings() {
      try {
        const { settings: loaded, defaultWorkdir } = await loadPersistedSettingsWithDefaults();
        if (!cancelled) {
          defaultWorkdirRef.current = defaultWorkdir;
          const loadedWithDefaults = applyRuntimeSystemDefaults(loaded, defaultWorkdir);
          setSettingsState(loadedWithDefaults);
          setSettingsSaveState({ status: "saved" });
          void publishGatewaySettingsSync(loadedWithDefaults).catch((error) => {
            console.error("publish gateway settings sync failed", error);
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSettingsState(getDefaultSettings());
          setSettingsSaveState({
            status: "error",
            message: asErrorMessage(error, "加载设置失败，已回退到默认配置。"),
          });
        }
      } finally {
        if (!cancelled) {
          setSettingsReady(true);
        }
      }
    }

    void hydrateSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  const queueSettingsSave = useCallback(
    (prev: AppSettings, next: AppSettings, fallback: string, publishSync: boolean) => {
      const saveSequence = ++saveSequenceRef.current;
      setSettingsSaveState({ status: "saving" });

      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(() => persistSettings(prev, next))
        .then(async (persistResult) => {
          const publishTarget = persistResult.ssh
            ? normalizeSettings({
                ...next,
                ssh: persistResult.ssh,
              })
            : next;
          if (persistResult.ssh && saveSequenceRef.current === saveSequence) {
            setSettingsState((current) =>
              normalizeSettings({
                ...current,
                ssh: persistResult.ssh,
              }),
            );
          }
          if (persistResult.conflict) {
            throw new Error(persistResult.conflict);
          }
          if (publishSync) {
            await publishGatewaySettingsSync(publishTarget);
          }
        })
        .then(() => {
          if (saveSequenceRef.current === saveSequence) {
            setSettingsSaveState({ status: "saved" });
          }
        })
        .catch((error) => {
          if (saveSequenceRef.current === saveSequence) {
            setSettingsSaveState({
              status: "error",
              message: asErrorMessage(error, fallback),
            });
          }
        });
    },
    [],
  );

  const setSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      setSettingsState((prev) => {
        const updated = updater(prev);
        if (updated === prev) return prev;
        const next = applyRuntimeSystemDefaults(
          normalizeSettings(updated),
          defaultWorkdirRef.current,
        );
        queueSettingsSave(
          prev,
          next,
          "保存设置失败。",
          hasSettingsSyncChanged(prev, next) || hasSensitiveSettingsUpdates(next),
        );
        return next;
      });
    },
    [queueSettingsSave],
  );

  const reloadPersistedSettings = useCallback(async () => {
    await saveChainRef.current.catch(() => undefined);
    const { settings: loaded, defaultWorkdir } = await loadPersistedSettingsWithDefaults();
    defaultWorkdirRef.current = defaultWorkdir;
    const loadedWithDefaults = applyRuntimeSystemDefaults(loaded, defaultWorkdir);
    setSettingsState(loadedWithDefaults);
    setSettingsSaveState({ status: "saved" });
  }, []);

  const toggleTheme = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      theme: prev.theme === "dark" ? "light" : "dark",
    }));
  }, [setSettings]);

  const openSettings = useCallback(
    (section: SectionId = "system") => {
      setSettingsSection(section);
      setSettingsOpen(true);
      setOverlay("entering");
      requestAnimationFrame(() => requestAnimationFrame(() => setOverlay("open")));
      void reloadPersistedSettings().catch((error) => {
        setSettingsSaveState({
          status: "error",
          message: asErrorMessage(error, "重新加载设置失败，当前显示的是旧配置。"),
        });
      });
    },
    [reloadPersistedSettings],
  );

  const closeSettings = useCallback(() => {
    setOverlay("leaving");
  }, []);

  const handleTransitionEnd = useCallback(() => {
    if (overlay === "leaving") {
      setSettingsOpen(false);
      setOverlay("closed");
    }
  }, [overlay]);

  // 构建 locale context value，避免每次渲染重新创建
  const localeContextValue = useMemo(
    () => ({
      locale: settings.locale,
      t: (key: string) => translate(key, settings.locale),
    }),
    [settings.locale],
  );

  const appUpdateMessages = useMemo(
    () => ({
      checkFailed: translate("settings.aboutUpdateCheckFailed", settings.locale),
      installFailed: translate("settings.aboutUpdateInstallFailed", settings.locale),
      restartFailed: translate("settings.aboutRestartFailed", settings.locale),
    }),
    [settings.locale],
  );

  const appUpdate = useAppUpdateController({
    enabled: settingsReady,
    includePrereleases: settings.updates.includePrereleases,
    messages: appUpdateMessages,
  });

  useEffect(() => {
    if (!settingsReady) {
      return;
    }

    let cancelled = false;
    const unlistenPromise = listen<GatewaySettingsSyncPayload>(
      GATEWAY_SETTINGS_SYNC_EVENT,
      (event) => {
        if (cancelled) {
          return;
        }

        setSettingsState((prev) => {
          const next = applyRuntimeSystemDefaults(
            applyGatewaySettingsSyncPayload(prev, event.payload),
            defaultWorkdirRef.current,
          );
          const publicChanged = hasSettingsSyncChanged(prev, next);
          if (!publicChanged && !hasSensitiveSettingsUpdatesPayload(event.payload)) {
            return prev;
          }
          queueSettingsSave(prev, next, "同步 WebUI 设置失败。", publicChanged);
          return next;
        });
      },
    );

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [queueSettingsSave, settingsReady]);

  if (!settingsReady) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <AppChrome appUpdate={appUpdate}>
          <div className="flex h-full w-full items-center justify-center bg-background text-sm text-muted-foreground">
            {translate("chat.loading", settings.locale)}
          </div>
        </AppChrome>
      </LocaleContext.Provider>
    );
  }

  const visible = settingsOpen;
  const active = overlay === "open";

  return (
    <LocaleContext.Provider value={localeContextValue}>
      <AppChrome appUpdate={appUpdate}>
        <CronPromptRunner settings={settings} />
        <MemoryOrganizerRunner settings={settings} setSettings={setSettings} />
        <ChatPage
          settings={settings}
          setSettings={setSettings}
          context={context}
          setContext={setContext}
          onOpenSettings={openSettings}
          onToggleTheme={toggleTheme}
          appUpdate={appUpdate}
        />
        {visible && (
          <div
            className={`absolute inset-0 z-50 transition-all duration-300 ease-out ${
              active ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
            }`}
            onTransitionEnd={handleTransitionEnd}
          >
            <SettingsPage
              settings={settings}
              setSettings={setSettings}
              saveState={settingsSaveState}
              onBack={closeSettings}
              initialSection={settingsSection}
              appUpdate={appUpdate}
            />
          </div>
        )}
      </AppChrome>
    </LocaleContext.Provider>
  );
}
