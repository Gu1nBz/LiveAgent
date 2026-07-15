import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { PetManifest } from "./types";

export const PET_LIBRARY_CHANGED_EVENT = "pet-library-changed";
export const PET_INSTALLED_EVENT = "pet-installed";

export type PetLibraryChangedEvent = {
  action: "installed" | "deleted";
  id: string;
  pet: PetManifest | null;
};

export type PetInstalledEvent = {
  pet: PetManifest;
  activate: boolean;
};

export type InstallGeneratedPetInput = {
  workspaceRoot: string;
  petDirectory: string;
  activate?: boolean;
};

export type BuildPetChromaKeyInput = {
  r: number;
  g: number;
  b: number;
  tolerance?: number;
};

export type BuildPetRowInput = {
  row: number;
  frameCount: number;
  path: string;
};

export type BuildGeneratedPetInput = {
  workspaceRoot: string;
  outputDirectory: string;
  id: string;
  displayName: string;
  description?: string;
  kind?: string;
  chromaKey?: BuildPetChromaKeyInput;
  rows: BuildPetRowInput[];
};

export type BuildGeneratedPetResult = {
  packageDirectory: string;
  pet: PetManifest;
};

const spritesheetCache = new Map<string, Promise<string>>();

function clearPetSpritesheetCache(id: string) {
  for (const key of spritesheetCache.keys()) {
    if (key.startsWith(`${id}:`)) spritesheetCache.delete(key);
  }
}

export async function listPets(): Promise<PetManifest[]> {
  return await invoke<PetManifest[]>("pet_list");
}

export async function getPetLibraryPath(): Promise<string> {
  return await invoke<string>("pet_library_path");
}

export async function scanCodexPets(): Promise<PetManifest[]> {
  return await invoke<PetManifest[]>("pet_scan_codex");
}

export async function importCodexPet(id: string): Promise<PetManifest> {
  const pet = await invoke<PetManifest>("pet_import_codex", { id });
  clearPetSpritesheetCache(id);
  return pet;
}

export async function installGeneratedPet(input: InstallGeneratedPetInput): Promise<PetManifest> {
  const pet = await invoke<PetManifest>("pet_install_generated", { input });
  clearPetSpritesheetCache(pet.id);
  return pet;
}

export async function buildGeneratedPet(
  input: BuildGeneratedPetInput,
): Promise<BuildGeneratedPetResult> {
  return await invoke<BuildGeneratedPetResult>("pet_build_generated", { input });
}

export async function deletePet(id: string): Promise<void> {
  await invoke("pet_delete", { id });
  clearPetSpritesheetCache(id);
}

export function readPetSpritesheet(id: string, assetVersion: string): Promise<string> {
  const cacheKey = `${id}:${assetVersion}`;
  const cached = spritesheetCache.get(cacheKey);
  if (cached) return cached;
  const baseUrl = convertFileSrc(`/${id}/spritesheet`, "liveagent-pet");
  const request = Promise.resolve(`${baseUrl}?v=${encodeURIComponent(assetVersion)}`);
  spritesheetCache.set(cacheKey, request);
  return request;
}
