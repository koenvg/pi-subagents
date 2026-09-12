import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { getHostBuiltinToolNames } from "../../src/runs/shared/child-tool-plan.ts";
import { buildSkillInjection, resolveSkills } from "../../src/agents/skills.ts";

// Opt in with an absolute path to a real Pi SDK entry point. The normal suite
// uses a Pi shim, which cannot prove native tool registration or execution.
const sdkPath = process.env.PI_NATIVE_SDK;

test("given a replacement host read, when a fresh native reviewer starts, then its skill is readable", {
	skip: !sdkPath && "Set PI_NATIVE_SDK to the real Pi SDK entry point",
}, async () => {
	assert.ok(sdkPath);
	const sdk: PiCodingAgentModule = await import(pathToFileURL(sdkPath).href);
	const cwd = mkdtempSync(join(tmpdir(), "pi-native-reviewer-read-"));
	mkdirSync(join(cwd, "review"));
	const skillPath = join(cwd, "review", "SKILL.md");
	const skill = "---\nname: review\ndescription: Review fixture\n---\n# Review\nCheck correctness and capability boundaries.\n";
	writeFileSync(skillPath, skill);
	let hostApi: ExtensionAPI | undefined;
	let nativeChild: Awaited<ReturnType<PiCodingAgentModule["createAgentSession"]>>["session"] | undefined;
	const errors: unknown[] = [];
	const settingsManager = sdk.SettingsManager.inMemory({});
	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [(pi) => {
			hostApi = pi;
			pi.registerTool({
				name: "read",
				label: "Replacement read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
				async execute(_id, params) {
					return { content: [{ type: "text", text: readFileSync(params.path, "utf8") }], details: {} };
				},
			});
		}],
	});
	await loader.reload();
	const { session: host } = await sdk.createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader: loader,
		sessionManager: sdk.SessionManager.inMemory(cwd),
		tools: ["read", "bash"],
	});
	const factory = createDefaultChildSessionFactory({
		loadPiCodingAgent: async () => ({
			...sdk,
			async createAgentSession(options) {
				const result = await sdk.createAgentSession(options);
				nativeChild = result.session;
				return result;
			},
		}),
	});
	try {
		await host.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
		assert.ok(hostApi);
		const tools = hostApi.getAllTools();
		assert.ok(tools.some((tool) => tool.name === "read" && tool.sourceInfo?.source !== "builtin"));
		assert.ok(tools.some((tool) => tool.name === "bash" && tool.sourceInfo?.source === "builtin"));
		const read = host.agent.state.tools.find((tool) => tool.name === "read");
		assert.ok(read);
		const hostResult = await read.execute("host-skill", { path: skillPath });
		assert.ok(hostResult.content.some((part) => part.type === "text" && part.text === skill));

		const skills = resolveSkills(["review"], cwd, [skillPath]);
		assert.deepEqual(skills.missing, []);
		const skillPrompt = buildSkillInjection(skills.resolved);
		assert.ok(skillPrompt.includes(skillPath));
		assert.ok(!skillPrompt.includes("Check correctness and capability boundaries."));
		const launch = buildInProcessChildLaunch({
			cwd,
			host: "parent",
			childAgentName: "delegate",
			childIndex: 0,
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			requireReadTool: skills.resolved.length > 0,
			systemPrompt: skillPrompt,
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
			hostAvailableBuiltins: getHostBuiltinToolNames(hostApi),
		});
		assert.ok(launch.toolPlan.requiredChildTools.includes("read"));
		const child = await factory.create({ ...launch.session, onExtensionError: (error) => errors.push(error) });
		assert.notEqual(child.sessionId, host.sessionId);
		assert.ok(nativeChild);
		const childRead = nativeChild.agent.state.tools.find((tool) => tool.name === "read");
		assert.ok(childRead);
		const childResult = await childRead.execute("child-skill", { path: skillPath });
		assert.ok(childResult.content.some((part) => part.type === "text" && part.text.includes("Check correctness and capability boundaries.")));
		assert.equal(launch.capture.toolDiagnostic(), undefined);
		assert.deepEqual(errors, []);
	} finally {
		await factory.dispose();
		host.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
