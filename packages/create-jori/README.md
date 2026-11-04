# create-jori

Install [Jori](https://getjori.ai), the assistant that keeps working while you're not asking, on the Claude subscription you already have.

```bash
npm create jori
```

It installs what is missing (Homebrew, Node.js 22.5+, git, Claude Code, Ollama), puts Jori in `~/Dev/jori`, and opens a setup page in your browser: sign in with Claude, confirm a few details, press **Start Jori**.

Options: `npm create jori -- ~/somewhere/else --no-setup --no-ollama`.

Same installer as `curl -fsSL https://getjori.ai/install.sh | bash` ([source](https://github.com/jori-ai/jori/blob/main/site/install.sh)). macOS; Linux partly.
