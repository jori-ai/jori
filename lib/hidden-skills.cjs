// hidden-skills — the skills a Jori agent session does not list.
//
// Every `claude -p` session re-reads the skill listing on every turn: dozens of
// skills, tens of thousands of chars. Three groups on it are never called by a
// Jori agent: the `anthropic-skills:*` synced from the claude.ai account (Office
// files, browsers, design), the installation's own ~/.claude/skills that are not
// Jori's (agent/local/config/fork-skills.json `hidden`), and the skills bundled
// with Claude Code. skillOverrides "user-invocable-only" hides a skill from the
// model and keeps /name; it is passed per session with --settings, so the user's
// own Claude Code sessions keep every skill.
//
// The forks get the same list from agent/scripts/lib/fork-connector-deny.sh
// (JORI_FORK_SKILL_SETTINGS); tests/hidden-skills.test.mjs keeps the two lists
// equal. The supervisors (ops tiers and chat) merge supervisorSkillOverrides()
// into their per-session --settings JSON; an agent opts out with
// `hideUnusedSkills: false` in its agents.json entry.
//
// Never hide workflow-authoring: with it hidden, Claude Code pastes the whole
// workflow reference into the Workflow tool's description instead. Plugin skills
// (`<plugin>:<skill>`) are out of reach: skillOverrides does not apply to them.

const ACCOUNT_SKILLS = [
  "anthropic-skills:brand-guidelines", "anthropic-skills:built-in-browser", "anthropic-skills:canvas-design",
  "anthropic-skills:chrome-browser", "anthropic-skills:computer-use", "anthropic-skills:deep-research",
  "anthropic-skills:docs", "anthropic-skills:docx", "anthropic-skills:google-workspace",
  "anthropic-skills:import-memory", "anthropic-skills:internal-comms", "anthropic-skills:mcp-builder",
  "anthropic-skills:morning", "anthropic-skills:pdf", "anthropic-skills:pptx", "anthropic-skills:skill-creator",
  "anthropic-skills:theme-factory", "anthropic-skills:xlsx",
];

const BUNDLED_SKILLS = [
  "claude-api", "code-review", "dataviz", "fewer-permission-prompts", "init", "keybindings-help",
  "loop", "run", "schedule", "security-review", "simplify", "update-config",
];

const NEVER_HIDE = new Set(["workflow-authoring"]);
const NAME_OK = /^[A-Za-z0-9:_.-]+$/; // lang-regex-ok: skill identifiers from config, not language

function localHidden(localConfig) {
  try {
    const read = localConfig || require("./instance.cjs").localConfig;
    const c = read("fork-skills", { hidden: [] });
    return Array.isArray(c && c.hidden) ? c.hidden : [];
  } catch {
    return [];
  }
}

function hiddenSkills({ localConfig } = {}) {
  const out = [];
  for (const s of [...ACCOUNT_SKILLS, ...localHidden(localConfig), ...BUNDLED_SKILLS]) {
    if (typeof s === "string" && NAME_OK.test(s) && !NEVER_HIDE.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

function supervisorSkillOverrides(opts = {}) {
  const o = {};
  for (const s of hiddenSkills(opts)) o[s] = "user-invocable-only";
  return o;
}

module.exports = { ACCOUNT_SKILLS, BUNDLED_SKILLS, hiddenSkills, supervisorSkillOverrides };
