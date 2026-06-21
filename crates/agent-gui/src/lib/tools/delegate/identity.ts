import type {
  SubagentIdentityRecord,
  SubagentRunStatus,
  SubagentRunSummary,
} from "../../chat/subagent/subagentHistory";
import type { DelegateAgentInput, DelegateAgentTemplate } from "./types";
import { truncateText } from "./utils";

export function normalizeLookupKey(value: string) {
  return value.trim().toLowerCase();
}

function normalizeIdentityKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`"'“”‘’\s]+/g, "")
    .replace(/[()[\]{}<>【】（）《》,，.。:：;；|\\/]+/g, "")
    .replace(/[_-]+/g, "-");
}

function escapeRegExp(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isAsciiWordChar(value: string | undefined) {
  return Boolean(value && /[a-zA-Z0-9_]/.test(value));
}

function identityKeyContainsSegment(textKey: string, segmentKey: string) {
  if (!textKey || !segmentKey) return false;
  if (textKey === segmentKey) return true;
  return (
    textKey.startsWith(`${segmentKey}-`) ||
    textKey.endsWith(`-${segmentKey}`) ||
    textKey.includes(`-${segmentKey}-`)
  );
}

function textContainsDelimitedName(text: string, knownName: string) {
  const name = knownName.trim();
  if (!text || !name) return false;
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? haystack[index - 1] : undefined;
    const after = haystack[index + needle.length];
    if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) return true;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return false;
}

function stripSubagentNameDecoration(value: string) {
  let text = value.trim();
  let previous = "";
  const leading =
    /^(?:agent\s*\d+|day\s*\d+|night\s*\d+|round\s*\d+|vote|pk|final|第[一二三四五六七八九十\d]+(?:天|夜|轮|回合)?|第一天|第二天|第三天|最终|终局|修正|投票|白天|夜晚)[\s._:：-]+/i;
  const trailing =
    /[\s._:：-]+(?:发言|回应|行动|查验|投票|决定|揭晓|总结|修正|确认|round\s*\d+|day\s*\d+|night\s*\d+|vote|pk|final)$/i;
  while (text && text !== previous) {
    previous = text;
    text = text.replace(leading, "").replace(trailing, "").trim();
  }
  return text;
}

function isSyntheticSubagentIdentity(value: string | undefined) {
  const text = value?.trim();
  if (!text) return true;
  return (
    /^(?:agent\s*-?\s*\d+|day\s*\d+|night\s*\d+|round\s*\d+|vote|pk|final)\b/i.test(text) ||
    /(?:会议|辩论|投票|行动|查验|最终|决定|揭晓|总结|法官|生死局|修正|round|night|day|vote|pk)/i.test(
      text,
    )
  );
}

function decoratedNameMatchesKnownName(candidate: string | undefined, knownName: string) {
  const text = candidate?.trim();
  const known = knownName.trim();
  if (!text || !known) return false;
  if (normalizeIdentityKey(text) === normalizeIdentityKey(known)) return true;
  const stripped = stripSubagentNameDecoration(text);
  if (stripped && normalizeIdentityKey(stripped) === normalizeIdentityKey(known)) {
    return true;
  }
  const textKey = normalizeIdentityKey(text);
  const knownKey = normalizeIdentityKey(known);
  return (
    textKey.length > knownKey.length &&
    textKey.endsWith(knownKey) &&
    isSyntheticSubagentIdentity(text)
  );
}

function textAddressesKnownName(text: string, knownName: string) {
  const name = knownName.trim();
  if (!name) return false;
  const escaped = escapeRegExp(name);
  const asciiTailGuard = isAsciiWordChar(name[name.length - 1]) ? "(?![a-zA-Z0-9_])" : "";
  return new RegExp(
    `(?:你是|我是|作为|扮演|以|请用|用)\\s*(?:【|\\(|（|「|『|“|")?${escaped}${asciiTailGuard}(?:】|\\)|）|」|』|”|")?`,
    "i",
  ).test(text);
}

export function createAgentTemplateLookup(templates: DelegateAgentTemplate[]) {
  const byKey = new Map<string, DelegateAgentTemplate>();
  for (const template of templates) {
    if (template.id.trim()) byKey.set(normalizeLookupKey(template.id), template);
    if (template.name.trim()) byKey.set(normalizeLookupKey(template.name), template);
  }
  return byKey;
}

export function formatConfiguredAgents(templates: DelegateAgentTemplate[]) {
  if (templates.length === 0) return "No configured AGENTS templates are available.";
  return templates
    .slice(0, 12)
    .map((template) => {
      const description = template.description ? ` - ${template.description}` : "";
      return `${template.id} (${template.name})${description}`;
    })
    .join("\n");
}

function normalizeSubagentRunStatus(value: string): SubagentRunStatus {
  return value === "completed" || value === "failed" || value === "cancelled" ? value : "running";
}

function titleizeStableId(value: string) {
  const words = value
    .trim()
    .split(/[^a-zA-Z0-9]+/g)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

export function latestRunsByLogicalAgent(runs: SubagentRunSummary[]) {
  const byId = new Map<string, SubagentRunSummary>();
  for (const run of runs.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
    const id = run.logicalAgentId?.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      ...run,
      logicalAgentId: id,
      status: normalizeSubagentRunStatus(run.status),
    });
  }
  return byId;
}

export function identitiesByLogicalAgent(records: SubagentIdentityRecord[]) {
  const byId = new Map<string, SubagentIdentityRecord>();
  for (const record of records) {
    const id = record.logicalAgentId?.trim();
    const name = record.displayName?.trim();
    if (!id || !name || byId.has(id)) continue;
    byId.set(id, {
      ...record,
      logicalAgentId: id,
      displayName: name,
      role: record.role.trim() || name,
      identityPrompt: record.identityPrompt.trim() || record.role.trim() || name,
      defaultMode: record.defaultMode.trim() || "readonly",
      defaultTaskIntent: record.defaultTaskIntent.trim() || "research",
      defaultApplyPolicy: record.defaultApplyPolicy.trim() || "none",
    });
  }
  return byId;
}

export function findKnownIdentityForTask(
  task: DelegateAgentInput,
  identitiesById: Map<string, SubagentIdentityRecord>,
) {
  if (!task.resume) return null;
  const exact = identitiesById.get(task.id);
  if (exact) return exact;
  if (task.taskIntent !== "communication") return null;

  const candidates: Array<{ identity: SubagentIdentityRecord; score: number }> = [];
  const idKey = normalizeIdentityKey(task.id);
  const promptText = `${task.name ?? ""}\n${task.prompt}`;
  for (const identity of identitiesById.values()) {
    const logicalId = identity.logicalAgentId.trim();
    const displayName = identity.displayName.trim();
    if (!logicalId || !displayName) continue;
    let score = 0;
    const logicalIdKey = normalizeIdentityKey(logicalId);
    if (identityKeyContainsSegment(idKey, logicalIdKey)) {
      score = Math.max(score, 95);
    }
    if (decoratedNameMatchesKnownName(task.name, displayName)) {
      score = Math.max(score, 90);
    }
    if (textAddressesKnownName(promptText, displayName)) {
      score = Math.max(score, 84);
    }
    if (score >= 80) candidates.push({ identity, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  if (!top) return null;
  const tied = candidates.filter((candidate) => candidate.score === top.score);
  return tied.length === 1 ? top.identity : null;
}

function referencedKnownIdentities(
  task: DelegateAgentInput,
  identitiesById: Map<string, SubagentIdentityRecord>,
) {
  const text = `${task.id}\n${task.name ?? ""}\n${task.prompt}`;
  const referenced: SubagentIdentityRecord[] = [];
  for (const identity of identitiesById.values()) {
    const id = identity.logicalAgentId?.trim();
    const name = identity.displayName?.trim();
    const idKey = id ? normalizeIdentityKey(id) : "";
    const idReferenced = Boolean(
      idKey &&
        [task.id, task.name ?? "", task.prompt].some((value) =>
          identityKeyContainsSegment(normalizeIdentityKey(value), idKey),
        ),
    );
    const nameReferenced =
      name &&
      (textContainsDelimitedName(text, name) ||
        decoratedNameMatchesKnownName(task.name, name) ||
        textAddressesKnownName(text, name));
    if (idReferenced || nameReferenced) referenced.push(identity);
  }
  return referenced;
}

export function shouldRejectLikelyExistingAgentFork(params: {
  task: DelegateAgentInput;
  identitiesByLogicalAgent: Map<string, SubagentIdentityRecord>;
}) {
  if (params.identitiesByLogicalAgent.size === 0) return null;
  if (params.identitiesByLogicalAgent.has(params.task.id)) return null;
  if (params.task.taskIntent !== "communication") return null;
  const referenced = referencedKnownIdentities(params.task, params.identitiesByLogicalAgent);
  if (referenced.length === 0) return null;
  const looksLikePhaseOrAggregate =
    isSyntheticSubagentIdentity(params.task.id) ||
    isSyntheticSubagentIdentity(params.task.name) ||
    isSyntheticSubagentIdentity(params.task.prompt);
  return looksLikePhaseOrAggregate ? referenced : null;
}

export function formatKnownSubagentRoster(
  identitiesById: Map<string, SubagentIdentityRecord>,
  latestRunsById: Map<string, SubagentRunSummary>,
) {
  const identities = Array.from(identitiesById.values());
  if (identities.length === 0) {
    return "No existing delegated agents are recorded for this parent conversation.";
  }
  return identities
    .slice(0, 12)
    .map((identity) => {
      const latestRun = latestRunsById.get(identity.logicalAgentId);
      const summary = latestRun?.summary ? ` summary=${truncateText(latestRun.summary, 500)}` : "";
      const status = latestRun?.status ? ` status=${latestRun.status}` : "";
      return [
        `id=${identity.logicalAgentId}`,
        `name=${identity.displayName}`,
        `role=${identity.role}`,
        `mode=${identity.defaultMode}`,
        status,
        summary,
      ]
        .filter(Boolean)
        .join(" ");
    })
    .join("\n");
}

function resolveSubagentDisplayName(params: {
  task: DelegateAgentInput;
  template?: DelegateAgentTemplate;
  identity?: SubagentIdentityRecord;
}) {
  return (
    params.identity?.displayName.trim() ||
    params.task.name?.trim() ||
    params.template?.name.trim() ||
    titleizeStableId(params.task.id) ||
    params.task.prompt.trim() ||
    params.task.id
  );
}

function resolveSubagentRole(params: {
  task: DelegateAgentInput;
  template?: DelegateAgentTemplate;
  identity?: SubagentIdentityRecord;
}) {
  return (
    params.identity?.role.trim() ||
    params.task.role?.trim() ||
    params.template?.description.trim() ||
    params.task.prompt.trim() ||
    "Delegated LiveAgent specialist"
  );
}

function buildIdentityPrompt(params: {
  task: DelegateAgentInput;
  template?: DelegateAgentTemplate;
  displayName: string;
  role: string;
}) {
  const lines = [
    params.task.identity?.trim(),
    params.template?.prompt.trim()
      ? `Configured template instructions:\n${params.template.prompt.trim()}`
      : "",
    params.task.prompt.trim() ? `Initial identity/task context:\n${params.task.prompt.trim()}` : "",
    `Identity summary: ${params.displayName} - ${params.role}`,
  ].filter(Boolean);
  return lines.join("\n\n");
}

export function createSubagentIdentity(params: {
  parentConversationId?: string;
  parentToolCallId: string;
  task: DelegateAgentInput;
  template?: DelegateAgentTemplate;
  now: number;
}): SubagentIdentityRecord {
  const displayName = resolveSubagentDisplayName({
    task: params.task,
    template: params.template,
  });
  const role = resolveSubagentRole({
    task: params.task,
    template: params.template,
  });
  return {
    parentConversationId: params.parentConversationId ?? "",
    logicalAgentId: params.task.id,
    displayName,
    role,
    identityPrompt: buildIdentityPrompt({
      task: params.task,
      template: params.template,
      displayName,
      role,
    }),
    agentId: params.task.agentId,
    templateName: params.template?.name,
    defaultMode: params.task.mode,
    defaultTaskIntent: params.task.taskIntent,
    defaultApplyPolicy: params.task.applyPolicy,
    createdParentToolCallId: params.parentToolCallId,
    createdAt: params.now,
    updatedAt: params.now,
  };
}
