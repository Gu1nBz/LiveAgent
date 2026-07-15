import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

import type { PetManifest } from "../pet/types";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

function argsFor(toolCall: ToolCall) {
  return toolCall.arguments &&
    typeof toolCall.arguments === "object" &&
    !Array.isArray(toolCall.arguments)
    ? (toolCall.arguments as Record<string, unknown>)
    : {};
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function result(
  toolCall: ToolCall,
  text: string,
  details: object,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details,
    isError,
    timestamp: Date.now(),
  };
}

function formatPet(pet: PetManifest) {
  return [
    `pet_id=${pet.id}`,
    `display_name=${pet.displayName}`,
    `sprite_version=${pet.spriteVersionNumber}`,
    `spritesheet_path=${pet.spritesheetPath}`,
    `source=${pet.source}`,
  ].join("\n");
}

function requiredText(args: Record<string, unknown>, key: string) {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseChromaKey(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = raw.match(/^#?([0-9a-f]{6})$/i);
  if (!match) throw new Error("chroma_key must be a six-digit hex color such as #00FF00");
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
    tolerance: 72,
  };
}

type PetBuildGeneratedResponse = {
  packageDirectory: string;
  pet: PetManifest;
};

const LIVEAGENT_V2_FRAME_COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8] as const;

export function createPetManagerTools(params: { workdir: string }): BuiltinToolBundle {
  const tool: Tool = {
    name: "PetManager",
    description:
      "Build an 8x11 LiveAgent v2 atlas from exactly 11 generated horizontal row strips and install it atomically, install an already packaged generated pet, or list installed pets. build_generated_and_install performs native chroma removal, frame fitting, canonical validation, packaging, installation, refresh, and optional activation. Never copy files directly into ~/.liveagent/pets.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("build_generated_and_install"),
          Type.Literal("install_generated"),
          Type.Literal("list"),
        ]),
        source_dir: Type.Optional(
          Type.String({
            description:
              "Generated package directory containing pet.json and the declared spritesheet.",
          }),
        ),
        activate: Type.Optional(
          Type.Boolean({
            description: "Select and show the installed pet after success. Defaults true.",
          }),
        ),
        output_dir: Type.Optional(
          Type.String({
            description: "Workspace package directory to create for build_generated_and_install.",
          }),
        ),
        id: Type.Optional(Type.String()),
        display_name: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        kind: Type.Optional(Type.String()),
        chroma_key: Type.Optional(
          Type.String({ description: "Six-digit chroma key used by generated row strips." }),
        ),
        rows: Type.Optional(
          Type.Array(
            Type.Object(
              {
                row: Type.Integer({ minimum: 0, maximum: 10 }),
                frame_count: Type.Integer({ minimum: 1, maximum: 8 }),
                path: Type.String(),
              },
              { additionalProperties: false },
            ),
            { minItems: 11, maxItems: 11 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  };

  async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
    try {
      const args = argsFor(toolCall);
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "list") {
        const pets = await invoke<PetManifest[]>("pet_list");
        return result(
          toolCall,
          pets.length > 0 ? pets.map(formatPet).join("\n\n") : "No LiveAgent pets are installed.",
          { pets },
        );
      }
      if (action === "build_generated_and_install") {
        const rows = Array.isArray(args.rows)
          ? args.rows.map((row, index) => {
              if (!row || typeof row !== "object" || Array.isArray(row)) {
                throw new Error(`rows[${index}] must be an object`);
              }
              const item = row as Record<string, unknown>;
              if (
                typeof item.row !== "number" ||
                typeof item.frame_count !== "number" ||
                typeof item.path !== "string" ||
                !item.path.trim()
              ) {
                throw new Error(`rows[${index}] requires row, frame_count, and path`);
              }
              return {
                row: item.row,
                frameCount: item.frame_count,
                path: item.path.trim(),
              };
            })
          : [];
        if (rows.length !== 11) throw new Error("rows must contain exactly 11 row strips");
        const rowByIndex = new Map(rows.map((row) => [row.row, row]));
        for (const [row, frameCount] of LIVEAGENT_V2_FRAME_COUNTS.entries()) {
          const item = rowByIndex.get(row);
          if (!item || item.frameCount !== frameCount) {
            throw new Error(`row ${row} must be provided once with frame_count=${frameCount}`);
          }
        }
        const outputDirectory = requiredText(args, "output_dir");
        const build = await invoke<PetBuildGeneratedResponse>("pet_build_generated", {
          input: {
            workspaceRoot: params.workdir,
            outputDirectory,
            id: requiredText(args, "id"),
            displayName: requiredText(args, "display_name"),
            description: typeof args.description === "string" ? args.description.trim() : "",
            kind: typeof args.kind === "string" ? args.kind.trim() || undefined : undefined,
            chromaKey: parseChromaKey(
              typeof args.chroma_key === "string" ? args.chroma_key : "#00FF00",
            ),
            rows,
          },
        });
        const pet = await invoke<PetManifest>("pet_install_generated", {
          input: {
            workspaceRoot: params.workdir,
            petDirectory: build.packageDirectory,
            activate: args.activate !== false,
          },
        });
        return result(
          toolCall,
          [
            "built=true",
            "installed=true",
            `activate=${args.activate !== false}`,
            `package=${build.packageDirectory}`,
            formatPet(pet),
          ].join("\n"),
          { pet, packageDirectory: build.packageDirectory, activate: args.activate !== false },
        );
      }
      if (action !== "install_generated") {
        throw new Error("action must be build_generated_and_install, install_generated, or list");
      }
      const sourceDir = typeof args.source_dir === "string" ? args.source_dir.trim() : "";
      if (!sourceDir) throw new Error("source_dir is required for install_generated");
      const pet = await invoke<PetManifest>("pet_install_generated", {
        input: {
          workspaceRoot: params.workdir,
          petDirectory: sourceDir,
          activate: args.activate !== false,
        },
      });
      return result(
        toolCall,
        `installed=true\nactivate=${args.activate !== false}\n${formatPet(pet)}`,
        {
          pet,
          activate: args.activate !== false,
        },
      );
    } catch (error) {
      return result(toolCall, errorText(error), {}, true);
    }
  }

  return {
    groupId: "system",
    tools: [tool],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        tool.name,
        {
          groupId: "system",
          kind: "pet_manager",
          isReadOnly: false,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
