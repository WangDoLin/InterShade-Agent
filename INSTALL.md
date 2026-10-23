# InterShader Installation Guide

InterShader is an autonomous coding agent and model gateway featuring a Hermes Agent-inspired terminal TUI and an empirical Proof Engine verification architecture.

---

## 1. System Requirements

- **Node.js:** Version `>= 22.5.0` (Node.js v22.5+ LTS or v24 LTS required for built-in `node:sqlite`).
- **Git:** Version `>= 2.30.0` (required for Shadow Worktree sandboxing and git diff verification).
- **Operating System:** Windows 10/11 (PowerShell), Linux (Ubuntu, Debian, Fedora, Arch), or macOS.
- **Terminal:** Supports ANSI TrueColor (Windows Terminal, iTerm2, Alacritty, Kitty, or VS Code integrated terminal).

---

## 2. One-Line Quick Install

### 2.1 On Windows (PowerShell)
Open PowerShell in the project directory and run:
```powershell
powershell -ExecutionPolicy ByPass -File scripts/install.ps1
```

The script automatically:
1. Verifies Node.js and Git prerequisites.
2. Installs required dependencies.
3. Compiles the production bundle via `tsup`.
4. Registers both global command aliases `intershader` and `intershade` via `npm link`.
5. Launches the Onboarding Setup Wizard to initialize your environment.

### 2.2 On Linux & macOS (Bash / Zsh)
Open your terminal in the project directory and run:
```bash
bash scripts/install.sh
```

---

## 3. Manual Installation from Source

If you prefer to perform each installation step manually:

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Compile Production Bundle
```bash
npm run build
```

### Step 3: Run the Onboarding Setup Wizard
```bash
npm run setup
```
or run directly via Node:
```bash
node dist/index.js setup
```

### Step 4: Register Global Commands (Global Link)
To run `intershader` and `intershade` from any terminal path:
```bash
npm link
```

---

## 4. Environment & API Keys Configuration

Copy the `.env.example` template into `.env`:
```bash
cp .env.example .env
```

Open `.env` and provide the API key for your chosen provider:

```env
# Anthropic Claude (Claude 3.7 Sonnet, Claude 3.5 Sonnet)
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (GPT-4o, o3-mini)
OPENAI_API_KEY=sk-proj-...

# DeepSeek (DeepSeek R1, DeepSeek V3)
DEEPSEEK_API_KEY=sk-...

# Google Gemini (Gemini 2.0 Flash)
GEMINI_API_KEY=AIza...

# Local LLM (Ollama / Local OpenAI-compatible endpoint)
OPENAI_BASE_URL=http://localhost:11434/v1

# Default Model Configuration
DEFAULT_PROVIDER=anthropic
DEFAULT_MODEL=claude-3-7-sonnet-20250219
```

---

## 5. Verifying Installation

Verify that the installation was successful using the following commands:

### 1. Check CLI Version
```bash
intershader --version
# or using the alias
intershade --version
```

### 2. Run Diagnostics & Environment Health Check
```bash
node dist/index.js /doctor
```

### 3. List Supported Models in Gateway Catalog
```bash
intershader models list
```

### 4. Launch Interactive Coding Agent
```bash
intershader
# or
intershade
```

---

## 6. Execution Modes

- **Plan Mode (Read-Only Exploration & Planning):**
  ```bash
  intershader --plan "Analyze repository architecture and design schema"
  ```
- **Proof Mode (Strict Empirical Verification Before Done):**
  ```bash
  intershader --proof "Refactor authentication service and produce evidence"
  ```
- **Custom Model and Provider Selection:**
  ```bash
  intershader -p deepseek -m deepseek-chat "Write unit tests for parser"
  ```
