/**
 * omp-compact-tools
 *
 * Three transcript display modes for tool calls:
 *
 *   default  omp's normal rendering (no interception).
 *   line     every tool call is exactly one line: name, target, result
 *            detail, duration; the line is ellipsis-truncated to fit.
 *   group    consecutive tool calls collapse into one summary line.
 *
 * Ctrl+O (the normal tool-output expansion toggle) expands whatever is
 * collapsed and renders the original tool cards.
 *
 * How it works: omp gives extensions the host's own module instances
 * (`@oh-my-pi/pi-tui/*` resolves through the bundled-module shim), so patching
 * `TranscriptContainer.prototype.addChild` intercepts every transcript block.
 * Tool blocks are diverted into a `ToolGroupComponent` instead of becoming
 * transcript children; the controller keeps updating them through
 * `pendingTools`, and the group renders their summary (collapsed) or their full
 * render (expanded).
 */

import { Container, Spacer, truncateToWidth } from "@oh-my-pi/pi-tui";
import { renderStatusLine } from "@oh-my-pi/pi-tui/render";
import { TranscriptContainer, trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type DisplayMode = "default" | "line" | "group";

const MODES: readonly DisplayMode[] = ["default", "line", "group"];
const CONFIG_PATH = join(getAgentDir(), "compact-tools.json");
const PATCH_KEY = Symbol.for("omp-compact-tools.patch");

type CompactConfig = {
	mode: DisplayMode;
};

const DEFAULT_CONFIG: CompactConfig = { mode: "line" };

const state = {
	mode: "line" as DisplayMode,
	idle: true,
	lastExpanded: false,
};

function isDisplayMode(value: unknown): value is DisplayMode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function loadConfig(): CompactConfig {
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (parsed && typeof parsed === "object") {
			if ("mode" in parsed && isDisplayMode(parsed.mode)) return { mode: parsed.mode };
			if ("enabled" in parsed && typeof parsed.enabled === "boolean") {
				return { mode: parsed.enabled ? "line" : "default" };
			}
		}
		return { ...DEFAULT_CONFIG };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: CompactConfig): void {
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		// A read-only config dir must not break the session.
	}
}

type CallInfo = {
	name: string;
	args: unknown;
	target?: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
	result?: unknown;
};

const calls = new Map<string, CallInfo>();
const memberCallIds = new WeakMap<object, string>();

function firstString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstString(item);
			if (found) return found;
		}
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) {
			const found = firstString(item);
			if (found) return found;
		}
	}
	return undefined;
}

/** Path from a hashline / apply-patch payload (`[path#tag]` or `*** Update File: path`). */
function pathFromPatch(input: string): string | undefined {
	for (const line of input.split("\n")) {
		const trimmed = line.trim();
		const bracket = /^\[([^\]#]+)#[0-9a-fA-F]{4}\]/.exec(trimmed);
		if (bracket) return bracket[1];
		const file = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/.exec(trimmed);
		if (file) return file[1];
	}
	return undefined;
}

function targetFromArgs(name: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	// Tool-call args are provider JSON; every read below is validated before use.
	const a = args as Record<string, unknown>;
	let raw: unknown;
	switch (name) {
		case "bash":
			raw = a.command;
			break;
		case "read":
		case "write":
			raw = a.path ?? a.file_path ?? a.filePath;
			break;
		case "edit":
		case "ast_edit":
		case "apply_patch": {
			raw = a.path ?? a.file_path ?? a.filePath;
			if (typeof raw !== "string" && typeof a.input === "string") raw = pathFromPatch(a.input);
			break;
		}
		case "grep":
		case "glob":
		case "find":
		case "ast_grep":
			raw = a.pattern ?? a.paths ?? a.path;
			break;
		case "web_search":
			raw = a.query;
			break;
		case "task":
			raw = a.description ?? a.agent ?? a.prompt;
			break;
		case "todo":
			raw = a.op;
			break;
		case "wait":
			raw = a.id;
			break;
		default:
			raw = firstString(a);
	}
	if (typeof raw !== "string") return undefined;
	const home = process.env.HOME;
	const shortened = home && raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
	return shortened.replace(/\s+/g, " ").trim();
}

function formatDuration(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms) || ms < 500) return undefined;
	const seconds = Math.round(ms / 100) / 10;
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest ? `${minutes}m${rest}s` : `${minutes}m`;
}

/** A member's method by name; unknown members degrade to undefined. */
function memberMethod(member: unknown, key: string): ((...args: unknown[]) => unknown) | undefined {
	if (!member || typeof member !== "object") return undefined;
	const value = Reflect.get(member, key);
	return typeof value === "function" ? value : undefined;
}

function firstLine(text: string): string | undefined {
	return text
		.split("\n")
		.map(line => line.trim())
		.find(Boolean);
}

function lineCount(text: string): number {
	return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

function diffStats(diff: string): { added: number; removed: number } | undefined {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return added || removed ? { added, removed } : undefined;
}

/** One-line result detail: what the call actually produced, per tool. */
function resultDetail(name: string, info: CallInfo | undefined): string | undefined {
	if (!info || info.endedAt === undefined) return undefined;
	const result = info.result as
		| { content?: Array<{ text?: string }>; details?: Record<string, unknown> }
		| undefined;
	const details = result?.details ?? {};
	const text = (result?.content ?? []).map(part => (typeof part.text === "string" ? part.text : "")).join("\n");
	const fallback = firstLine(text);
	switch (name) {
		case "bash": {
			const lines = text ? lineCount(text) : 0;
			const exit = typeof details.exitCode === "number" ? details.exitCode : undefined;
			if (lines === 1) return fallback;
			const parts = [
				lines > 1 ? `${lines} lines` : undefined,
				details.timedOut === true ? "timed out" : undefined,
				exit !== undefined && exit !== 0 ? `exit ${exit}` : undefined,
			].filter((part): part is string => Boolean(part));
			return parts.length > 0 ? parts.join(" · ") : fallback;
		}
		case "read": {
			const summary = details.summary as { lines?: number } | undefined;
			const total = typeof details.totalLines === "number" ? details.totalLines : undefined;
			const count = summary?.lines ?? total;
			if (details.isDirectory === true) return "directory";
			return count !== undefined ? `${count} ${count === 1 ? "line" : "lines"}` : fallback;
		}
		case "grep": {
			const matches = typeof details.matchCount === "number" ? details.matchCount : undefined;
			const files = typeof details.fileCount === "number" ? details.fileCount : undefined;
			if (matches === undefined) return fallback;
			const parts = [`${matches} ${matches === 1 ? "match" : "matches"}`];
			if (files !== undefined) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
			return parts.join(" · ");
		}
		case "glob": {
			const files = typeof details.fileCount === "number" ? details.fileCount : undefined;
			return files !== undefined ? `${files} ${files === 1 ? "file" : "files"}` : fallback;
		}
		case "edit": {
			const stats = diffStats(typeof details.diff === "string" ? details.diff : "");
			return stats ? `+${stats.added}/-${stats.removed}` : fallback;
		}
		case "write": {
			const content =
				info.args && typeof info.args === "object" ? Reflect.get(info.args, "content") : undefined;
			if (typeof content !== "string") return fallback;
			const count = lineCount(content);
			return `${count} ${count === 1 ? "line" : "lines"}`;
		}
		case "task": {
			const async = details.async as { state?: string } | undefined;
			if (async?.state) return async.state;
			const results = Array.isArray(details.results) ? details.results.length : undefined;
			return results !== undefined ? `${results} ${results === 1 ? "agent" : "agents"}` : fallback;
		}
		default:
			return fallback;
	}
}

type MemberMeta = {
	name: string;
	status: string;
	target?: string;
	detail?: string;
	tookMs?: number;
};

function textOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const joined = value.map(part => (typeof part === "string" ? part : textOf(part)) ?? "").join("");
		return joined || undefined;
	}
	if (value && typeof value === "object" && "t" in value && typeof value.t === "string") return value.t;
	return undefined;
}

/** Props from the component's own describe() node (compiled binaries minify `props` to `p`). */
function memberProps(member: unknown): Record<string, unknown> {
	const describe = memberMethod(member, "describe");
	if (!describe) return {};
	try {
		const node = Reflect.apply(describe, member, []);
		if (!node || typeof node !== "object") return {};
		const props = Reflect.get(node, "p") ?? Reflect.get(node, "props");
		return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function memberMeta(member: unknown): MemberMeta {
	const props = memberProps(member);
	const role = typeof props.role === "string" ? props.role : "";
	const propName = role.startsWith("omp.tool.") ? role.slice("omp.tool.".length) : undefined;
	const propId = typeof props.key === "string" ? props.key : undefined;
	const id = (member && typeof member === "object" ? memberCallIds.get(member) : undefined) ?? propId;
	const info = id ? calls.get(id) : undefined;
	const name = member instanceof ReadToolGroupComponent ? "read" : (info?.name ?? propName ?? "tool");
	const finalized = Boolean(memberMethod(member, "isTranscriptBlockFinalized")?.call(member));
	let status = typeof props.status === "string" ? props.status : "done";
	if (info?.endedAt !== undefined) {
		status = info.isError ? "error" : "done";
	} else if (info && status === "done") {
		status = "running";
	} else if (status === "done" && !finalized) {
		status = "running";
	}
	const tookMs =
		typeof props.took === "number"
			? props.took
			: typeof props.age === "number"
				? props.age
				: info
					? (info.endedAt ?? Date.now()) - info.startedAt
					: undefined;
	return {
		name,
		status,
		target: info?.target ?? textOf(props.target),
		detail: resultDetail(name, info),
		tookMs,
	};
}

/** Rebuild tool-call metadata for resumed transcripts (replay emits no tool events). */
function seedCallsFromHistory(ctx: ExtensionContext): void {
	calls.clear();
	let entries: unknown;
	try {
		entries = ctx.sessionManager.getBranch();
	} catch {
		return;
	}
	if (!Array.isArray(entries)) return;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || Reflect.get(entry, "type") !== "message") continue;
		const message = Reflect.get(entry, "message");
		if (!message || typeof message !== "object") continue;
		const rawTimestamp = Reflect.get(entry, "timestamp");
		const parsed = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : Number.NaN;
		const timestamp = Number.isFinite(parsed) ? parsed : Date.now();
		const role = Reflect.get(message, "role");
		if (role === "assistant") {
			const content = Reflect.get(message, "content");
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (!block || typeof block !== "object" || Reflect.get(block, "type") !== "toolCall") continue;
				const id = Reflect.get(block, "id");
				const name = Reflect.get(block, "name");
				if (typeof id !== "string" || typeof name !== "string") continue;
				const args = Reflect.get(block, "arguments");
				calls.set(id, { name, args, target: targetFromArgs(name, args), startedAt: timestamp });
			}
			continue;
		}
		if (role !== "toolResult") continue;
		const id = Reflect.get(message, "toolCallId");
		if (typeof id !== "string") continue;
		const info = calls.get(id);
		if (!info) continue;
		info.endedAt = timestamp;
		info.isError = Reflect.get(message, "isError") === true;
		info.result = { content: Reflect.get(message, "content"), details: Reflect.get(message, "details") };
	}
}

const TOOL_LABELS: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	edit: "Edit",
	apply_patch: "Patch",
	write: "Write",
	grep: "Grep",
	glob: "Glob",
	find: "Find",
	task: "Task",
	todo: "Todo",
	wait: "Wait",
	web_search: "Web search",
	ast_edit: "AST edit",
	ast_grep: "AST grep",
	eval: "Eval",
	lsp: "LSP",
	github: "GitHub",
	debug: "Debug",
	ida: "IDA",
};

function toolLabel(name: string): string {
	const known = TOOL_LABELS[name];
	if (known) return known;
	return name.length > 0 ? `${name[0]!.toUpperCase()}${name.slice(1)}` : name;
}

type SymbolKey = Parameters<typeof theme.styledSymbol>[0];

/** Theme symbol per tool, matching the glyphs the original cards use in their headers. */
const TOOL_SYMBOLS: Record<string, SymbolKey> = {
	bash: "tool.bash",
	edit: "tool.edit",
	ast_edit: "tool.edit",
	apply_patch: "tool.edit",
	write: "tool.write",
	task: "tool.task",
	todo: "tool.todo",
	web_search: "tool.webSearch",
	grep: "tool.webSearch",
	glob: "tool.webSearch",
	find: "tool.webSearch",
	ast_grep: "tool.webSearch",
	lsp: "tool.lsp",
	debug: "tool.debug",
	eval: "tool.eval",
	github: "tool.gh",
	ask: "tool.ask",
};

function statusLineIcon(
	name: string,
	status: string,
	frame: number,
): { icon?: "running" | "error" | "done" | "aborted"; iconOverride?: string; spinnerFrame?: number } {
	if (status === "running" || status === "pending") return { icon: "running", spinnerFrame: frame };
	if (status === "error") return { icon: "error" };
	if (status === "cancelled") return { icon: "aborted" };
	const symbol: SymbolKey | undefined = Reflect.get(TOOL_SYMBOLS, name);
	return symbol ? { iconOverride: theme.styledSymbol(symbol, "accent") } : { icon: "done" };
}

function renderMember(member: unknown, width: number): readonly string[] {
	const render = memberMethod(member, "render");
	return render ? (Reflect.apply(render, member, [width]) as readonly string[]) : [];
}

class ToolGroupComponent extends Container {
	members: unknown[] = [];
	closed = false;
	expanded = false;
	visible = true;
	#version = 0;
	#startedAt = Date.now();

	addMember(member: unknown): void {
		this.members.push(member);
		this.#version++;
		this.invalidate();
	}

	removeMember(member: unknown): void {
		const index = this.members.indexOf(member);
		if (index < 0) return;
		this.members.splice(index, 1);
		this.#version++;
		this.invalidate();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.#version++;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		state.lastExpanded = expanded;
		for (const member of this.members) {
			memberMethod(member, "setExpanded")?.call(member, expanded);
		}
		this.invalidate();
	}

	setToolActivityVisible(visible: boolean): void {
		this.visible = visible;
		for (const member of this.members) {
			memberMethod(member, "setToolActivityVisible")?.call(member, visible);
		}
		this.invalidate();
	}

	isTranscriptBlockFinalized(): boolean {
		if (!this.visible) return true;
		if (!this.closed && !state.idle) return false;
		return this.members.every(member => {
			const finalized = memberMethod(member, "isTranscriptBlockFinalized");
			return finalized ? Boolean(finalized.call(member)) : true;
		});
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	/** One call, one line: themed symbol, name, target, result detail, duration. */
	#singleLine(width: number, meta: MemberMeta): string {
		const frame = Math.floor(Date.now() / 100);
		const line = renderStatusLine(
			{
				...statusLineIcon(meta.name, meta.status, frame),
				title: toolLabel(meta.name),
				titleColor: "toolTitle",
				description: meta.target,
				meta: [meta.detail, formatDuration(meta.tookMs)].filter((part): part is string => Boolean(part)),
			},
			theme,
		);
		return truncateToWidth(line, width);
	}

	/** Several calls, one line: counts by tool, failures, total duration. */
	#groupLine(width: number): string {
		const metas = this.members.map(memberMeta);
		if (metas.length === 0) return "";
		const running = metas.some(meta => meta.status === "running" || meta.status === "pending");
		const failed = metas.filter(meta => meta.status === "error").length;
		const settled = metas.every(meta => meta.status !== "running" && meta.status !== "pending");
		const durations = metas
			.map(meta => meta.tookMs)
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		const wall = settled
			? durations.reduce((sum, value) => sum + value, 0)
			: Date.now() - this.#startedAt;
		const duration = settled && durations.length === 0 ? undefined : formatDuration(wall);

		const counts = new Map<string, number>();
		for (const meta of metas) {
			const label = toolLabel(meta.name);
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
		const parts = [...counts.entries()].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
		const line = renderStatusLine(
			{
				icon: running ? "running" : failed > 0 ? "error" : "done",
				spinnerFrame: running ? Math.floor(Date.now() / 100) : undefined,
				title: `${metas.length} tools`,
				titleColor: "toolTitle",
				description: parts.join(" · "),
				meta: [failed > 0 ? `${failed} failed` : undefined, duration].filter(
					(part): part is string => Boolean(part),
				),
			},
			theme,
		);
		return truncateToWidth(line, width);
	}

	override render(width: number): readonly string[] {
		if (!this.visible || this.members.length === 0) return [];
		if (state.mode === "default") {
			return this.members.flatMap(member => renderMember(member, width));
		}
		if (this.members.length === 1 && this.members[0] instanceof ReadToolGroupComponent) {
			return renderMember(this.members[0], width);
		}
		if (this.expanded) {
			const header =
				this.members.length === 1 ? this.#singleLine(width, memberMeta(this.members[0])) : this.#groupLine(width);
			const lines: string[] = header ? [header] : [];
			for (const member of this.members) {
				const block = trimBlankEdges(renderMember(member, width));
				if (block.length === 0) continue;
				if (lines.length > 0) lines.push("");
				lines.push(...block);
			}
			return lines;
		}
		if (state.mode === "line") {
			return this.members.flatMap(member =>
				member instanceof ReadToolGroupComponent
					? renderMember(member, width)
					: [this.#singleLine(width, memberMeta(member))],
			);
		}
		if (this.members.length === 1) return [this.#singleLine(width, memberMeta(this.members[0]))];
		return [this.#groupLine(width)];
	}

	override dispose(): void {
		for (const member of this.members) {
			memberMethod(member, "dispose")?.call(member);
		}
		this.members = [];
		super.dispose();
	}
}

const openGroups = new WeakMap<TranscriptContainer, ToolGroupComponent>();
const groupOfMember = new WeakMap<object, ToolGroupComponent>();

function isToolBlock(component: unknown): boolean {
	return component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent;
}

function closeOpenGroup(container: TranscriptContainer): void {
	const group = openGroups.get(container);
	if (!group) return;
	group.close();
	openGroups.delete(container);
}

/** Assistant blocks that render no rows (tool-only steps) must not split a tool run. */
function isTransparentBlock(component: unknown): boolean {
	if (!(component instanceof AssistantMessageComponent) && !(component instanceof Spacer)) return false;
	const render = memberMethod(component, "render");
	if (!render) return true;
	try {
		const lines = Reflect.apply(render, component, [160]) as readonly string[];
		return lines.every(line => !/\S/.test(line));
	} catch {
		return false;
	}
}

const MEMBER_PATCH_KEY = Symbol.for("omp-compact-tools.member-patch");
const MEMBER_ID_ARG: Record<string, number> = {
	updateArgs: 1,
	setArgsComplete: 0,
	setExecutionStarted: 0,
	updateResult: 2,
};

/** Capture the tool-call id the controller passes to each component update. */
function installMemberIdPatch(): void {
	const proto = ToolExecutionComponent.prototype as unknown as Record<PropertyKey, unknown>;
	if (proto[MEMBER_PATCH_KEY]) return;
	for (const [method, idIndex] of Object.entries(MEMBER_ID_ARG)) {
		const original = proto[method];
		if (typeof original !== "function") continue;
		proto[method] = function patchedMemberUpdate(this: object, ...args: unknown[]) {
			const id = args[idIndex];
			if (typeof id === "string") memberCallIds.set(this, id);
			return Reflect.apply(original, this, args);
		};
	}
	proto[MEMBER_PATCH_KEY] = true;
}

function installTranscriptPatch(): void {
	const proto = TranscriptContainer.prototype as unknown as Record<PropertyKey, unknown> & {
		addChild: (component: unknown) => void;
		removeChild: (component: unknown) => void;
		clear: () => void;
	};
	if (proto[PATCH_KEY]) return;
	const originalAddChild = proto.addChild;
	const originalRemoveChild = proto.removeChild;
	const originalClear = proto.clear;

	proto.addChild = function patchedAddChild(this: TranscriptContainer, component: unknown): void {
		if (state.mode === "default") {
			closeOpenGroup(this);
			originalAddChild.call(this, component);
			return;
		}
		if (isToolBlock(component)) {
			let group = openGroups.get(this);
			if (group?.closed) group = undefined;
			if (group) {
				const index = this.children.indexOf(group);
				if (index < 0 || !this.children.slice(index + 1).every(isTransparentBlock)) group = undefined;
			}
			if (!group) {
				group = new ToolGroupComponent();
				group.expanded = state.lastExpanded;
				openGroups.set(this, group);
				originalAddChild.call(this, group);
			}
			group.addMember(component);
			groupOfMember.set(component as object, group);
			this.invalidate();
			return;
		}
		if (isTransparentBlock(component)) {
			originalAddChild.call(this, component);
			return;
		}
		closeOpenGroup(this);
		originalAddChild.call(this, component);
	};

	proto.removeChild = function patchedRemoveChild(this: TranscriptContainer, component: unknown): void {
		const group = groupOfMember.get(component as object);
		if (group) {
			group.removeMember(component);
			groupOfMember.delete(component as object);
			this.invalidate();
			return;
		}
		originalRemoveChild.call(this, component);
	};

	proto.clear = function patchedClear(this: TranscriptContainer): void {
		// The replay builder stages blocks in one container and re-adds the same
		// components after clearing it; disposing groups here would empty them.
		openGroups.delete(this);
		originalClear.call(this);
	};

	proto[PATCH_KEY] = true;
}

const INPUT_PATCH_KEY = Symbol.for("omp-compact-tools.input-patch");

/**
 * Ctrl+O only repaints live blocks; rows already retired to terminal
 * scrollback keep their committed presentation. Force the full replay that
 * every block goes through, so expansion applies to the whole transcript.
 */
function installExpansionPatch(): void {
	const proto = InputController.prototype as unknown as Record<PropertyKey, unknown> & {
		setToolsExpanded?: (expanded: boolean) => void;
	};
	if (proto[INPUT_PATCH_KEY]) return;
	const original = proto.setToolsExpanded;
	if (typeof original !== "function") return;
	proto.setToolsExpanded = function patchedSetToolsExpanded(this: object, expanded: boolean) {
		Reflect.apply(original, this, [expanded]);
		const ctx = Reflect.get(this, "ctx");
		const chat = ctx && typeof ctx === "object" ? Reflect.get(ctx, "chatContainer") : undefined;
		const resetStable = chat && typeof chat === "object" ? Reflect.get(chat, "resetStableEmission") : undefined;
		if (typeof resetStable === "function") Reflect.apply(resetStable, chat, []);
		const ui = ctx && typeof ctx === "object" ? Reflect.get(ctx, "ui") : undefined;
		const reset = ui && typeof ui === "object" ? Reflect.get(ui, "resetDisplay") : undefined;
		if (typeof reset === "function") Reflect.apply(reset, ui, []);
	};
	proto[INPUT_PATCH_KEY] = true;
}

export default function compactTools(pi: ExtensionAPI): void {
	state.mode = loadConfig().mode;
	try {
		installMemberIdPatch();
		installTranscriptPatch();
		installExpansionPatch();
	} catch (error) {
		pi.logger?.warn?.(`compact-tools: transcript patch unavailable (${String(error)})`);
	}

	pi.on("session_start", (_event, ctx) => {
		state.idle = true;
		seedCallsFromHistory(ctx);
	});

	pi.on("agent_start", () => {
		state.idle = false;
	});

	pi.on("agent_end", () => {
		state.idle = true;
	});

	pi.on("tool_execution_start", event => {
		state.idle = false;
		if (calls.size > 2000) {
			const oldest = calls.keys().next().value;
			if (oldest !== undefined) calls.delete(oldest);
		}
		calls.set(event.toolCallId, {
			name: event.toolName,
			args: event.args,
			target: targetFromArgs(event.toolName, event.args),
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end", event => {
		const info = calls.get(event.toolCallId);
		if (!info) return;
		info.endedAt = Date.now();
		info.isError = event.isError;
		info.result = event.result;
	});

	const applyMode = (ctx: ExtensionContext): void => {
		saveConfig({ mode: state.mode });
		const getExpanded = Reflect.get(ctx.ui, "getToolsExpanded");
		const expanded = typeof getExpanded === "function" ? Boolean(Reflect.apply(getExpanded, ctx.ui, [])) : false;
		state.lastExpanded = expanded;
		const setExpanded = Reflect.get(ctx.ui, "setToolsExpanded");
		if (typeof setExpanded === "function") Reflect.apply(setExpanded, ctx.ui, [expanded]);
	};

	pi.registerCommand("compact-tools", {
		description: "Tool display mode: default | line | group",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "status" || value === "") {
				if (value === "") {
					const index = MODES.indexOf(state.mode);
					state.mode = MODES[(index + 1) % MODES.length]!;
					applyMode(ctx);
				}
				ctx.ui.notify(`compact-tools: ${state.mode}`, "info");
				return;
			}
			if (value === "off") {
				state.mode = "default";
			} else if (value === "on") {
				state.mode = "line";
			} else if (isDisplayMode(value)) {
				state.mode = value;
			} else {
				ctx.ui.notify("Usage: /compact-tools [default|line|group|status]", "warning");
				return;
			}
			applyMode(ctx);
			ctx.ui.notify(`compact-tools: ${state.mode}`, "info");
		},
	});
}
