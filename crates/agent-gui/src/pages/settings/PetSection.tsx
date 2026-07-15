import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, RefreshCw } from "../../components/icons";
import { PetSprite } from "../../components/pet/PetSprite";
import { Button } from "../../components/ui/button";
import {
  getPetLibraryPath,
  importCodexPet,
  listPets,
  PET_LIBRARY_CHANGED_EVENT,
  scanCodexPets,
} from "../../lib/pet/api";
import type { PetManifest } from "../../lib/pet/types";
import type { PetSettings } from "../../lib/settings";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function PetSection({ settings, setSettings }: SettingsSectionProps) {
  const [installed, setInstalled] = useState<PetManifest[]>([]);
  const [codexPets, setCodexPets] = useState<PetManifest[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [libraryPath, setLibraryPath] = useState("");
  const isEnglish = settings.locale === "en-US";

  const loadInstalled = useCallback(async () => {
    setLoading(true);
    try {
      const [pets, path] = await Promise.all([listPets(), getPetLibraryPath()]);
      setInstalled(pets);
      setLibraryPath(path);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  useEffect(() => {
    const unlistenPromise = listen(PET_LIBRARY_CHANGED_EVENT, () => {
      void loadInstalled();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [loadInstalled]);

  const patchSettings = (patch: Partial<PetSettings>) => {
    setSettings((previous) => ({
      ...previous,
      pet: { ...previous.pet, ...patch },
    }));
  };

  const installedIds = useMemo(() => new Set(installed.map((pet) => pet.id)), [installed]);

  const scanCodex = async () => {
    setScanning(true);
    setMessage(null);
    try {
      setCodexPets(await scanCodexPets());
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setScanning(false);
    }
  };

  const importPet = async (id: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      const pet = await importCodexPet(id);
      await loadInstalled();
      patchSettings({ activePetId: pet.id, enabled: true });
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusyId(null);
    }
  };

  const thumbnailSettings: PetSettings = {
    ...settings.pet,
    scale: 0.25,
    pointerTracking: "off",
    reducedMotion: true,
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{isEnglish ? "Pets" : "宠物"}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {isEnglish
                ? "Choose a companion to float on your desktop."
                : "选择一个陪伴你的桌面悬浮宠物。"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {isEnglish ? "Show pet" : "显示宠物"}
            </span>
            <AgentActivationSwitch
              checked={settings.pet.enabled}
              disabled={!settings.pet.activePetId}
              title={isEnglish ? "Show desktop pet" : "显示桌面宠物"}
              onToggle={() => patchSettings({ enabled: !settings.pet.enabled })}
            />
          </div>
        </div>

        {message ? (
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {message}
          </div>
        ) : null}

        {codexPets !== null ? (
          <div className="rounded-xl border border-border/60 bg-muted/15 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium">
                {isEnglish ? "Codex pets available to import" : "可导入的 Codex 宠物"}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setCodexPets(null)}>
                {isEnglish ? "Close" : "收起"}
              </Button>
            </div>
            {codexPets.length > 0 ? (
              <div className="divide-y divide-border/60">
                {codexPets.map((pet) => (
                  <PetRow
                    key={pet.id}
                    pet={pet}
                    settings={thumbnailSettings}
                    action={
                      <Button
                        size="sm"
                        disabled={busyId === pet.id}
                        onClick={() => void importPet(pet.id)}
                      >
                        {busyId === pet.id
                          ? isEnglish
                            ? "Importing"
                            : "导入中"
                          : installedIds.has(pet.id)
                            ? isEnglish
                              ? "Update"
                              : "更新"
                            : isEnglish
                              ? "Import"
                              : "导入"}
                      </Button>
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {isEnglish ? "No Codex pets were found." : "未发现可导入的 Codex 宠物。"}
              </div>
            )}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-border/60 px-4">
          {installed.map((pet) => {
            const selected = settings.pet.activePetId === pet.id;
            return (
              <PetRow
                key={pet.id}
                pet={pet}
                settings={thumbnailSettings}
                action={
                  <Button
                    variant={selected ? "ghost" : "secondary"}
                    size="sm"
                    disabled={selected}
                    onClick={() => patchSettings({ activePetId: pet.id, enabled: true })}
                  >
                    {selected ? (isEnglish ? "Selected" : "已选") : isEnglish ? "Select" : "选择"}
                  </Button>
                }
              />
            );
          })}
          {!loading && installed.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {isEnglish
                ? "No pets yet. Import one from Codex to get started."
                : "还没有宠物，点击“导入 Codex 宠物”开始使用。"}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4 border-t border-border/60 py-3">
            <div className="min-w-0">
              <div className="text-xs font-medium">
                {isEnglish ? "LiveAgent pet folder" : "LiveAgent 宠物文件夹"}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                {libraryPath || "~/.liveagent/pets"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 bg-background px-2.5 text-xs shadow-none"
                onClick={() => void scanCodex()}
                disabled={scanning}
              >
                {scanning ? (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                )}
                {isEnglish ? "Import from Codex" : "从 Codex 导入"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2.5 text-xs text-muted-foreground"
                disabled={!libraryPath}
                onClick={() => {
                  void openPath(libraryPath).catch((error) => setMessage(errorText(error)));
                }}
              >
                {isEnglish ? "Open folder" : "打开文件夹"}
                <ExternalLink className="ml-1 h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="text-sm font-medium">{isEnglish ? "Appearance" : "外观"}</div>
        <label className="flex items-center gap-6 rounded-xl border border-border/60 px-4 py-4">
          <span className="min-w-28">
            <span className="block text-sm font-medium">{isEnglish ? "Pet size" : "宠物大小"}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {isEnglish ? "Adjust pet size" : "调整宠物大小"}
            </span>
          </span>
          <input
            type="range"
            min="0.45"
            max="1.25"
            step="0.05"
            value={settings.pet.scale}
            onChange={(event) => patchSettings({ scale: Number(event.target.value) })}
            className="min-w-0 flex-1 accent-primary"
          />
        </label>
      </section>
    </div>
  );
}

function PetRow(props: { pet: PetManifest; settings: PetSettings; action: ReactNode }) {
  return (
    <div className="flex min-h-20 items-center gap-3 py-3">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden">
        <PetSprite pet={props.pet} state="idle" settings={props.settings} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{props.pet.displayName}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {props.pet.description ||
            (props.pet.spriteVersion === "codex-v2" ? "Codex v2" : "Codex v1")}
        </div>
      </div>
      <div className="shrink-0">{props.action}</div>
    </div>
  );
}
