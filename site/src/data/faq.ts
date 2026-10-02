/** Answers checked against the app's code and release configuration. HTML allowed for links. */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'What should I hand it first?',
    a: 'Start by asking questions about a project in Ask mode, where it reads and answers. Then a small bug fix with a Done when check. The <a href="/use-cases/">use cases</a> go on from there, each one building on the last.'
  },
  {
    q: 'Is Agent V free?',
    a: 'Yes. Agent V is open source under GPL-3.0-or-later and costs nothing. You pay your model provider for what your tasks use, or nothing at all with a local model through Ollama.'
  },
  {
    q: 'Which models can it use?',
    a: 'OpenAI, Anthropic, Gemini, DeepSeek, Groq, OpenRouter, xAI, Mistral and OpenCode Go with your own keys; Amazon Bedrock and Google Vertex AI with your cloud credentials; Azure OpenAI or any OpenAI-compatible server such as vLLM, llama.cpp or LM Studio as a custom endpoint; and Ollama running locally with no key. See <a href="/docs/models-and-keys">Models and keys</a>.'
  },
  {
    q: 'Does my code go to Vyotiq?',
    a: 'No. There is no Vyotiq account or server. Model requests go straight from your machine to the provider you chose, with your key. <a href="/privacy">Privacy</a> lists everything that leaves your machine.'
  },
  {
    q: 'Can it work without the internet?',
    a: 'The agent can, with a local model: Ollama or an OpenAI-compatible server on your machine or network. A few things still use the internet when they can: the update check (which you can turn off), the public model catalogue, and the one-time download of the code index model.'
  },
  {
    q: 'Which systems does it run on?',
    a: 'Windows (x64), macOS on Apple silicon and Intel, and Linux (x64) as an AppImage, .deb or .rpm. <a href="/download">Download</a> has the installers.'
  },
  {
    q: 'Why does Windows or macOS warn me when I open it?',
    a: 'The builds are not code-signed or notarized yet, so SmartScreen and Gatekeeper warn on first launch. <a href="/download">Download</a> shows how to open it, and the source is public if you would rather build it yourself.'
  },
  {
    q: 'Do I need git?',
    a: 'Not to start. Worktrees, instances on their own branch, uncommitted changes, commits and pull requests need git on your PATH. Some MCP servers also need Node.js or uv.'
  },
  {
    q: 'What does a task cost?',
    a: 'It depends on the model and the task. Every run ends with a receipt showing tokens and cost, and the Usage page adds it up per day. Costs are the provider\'s own figure when it reports one, and otherwise estimated from published prices. You can also set a spend limit per task in Settings, Agent: at the limit the task asks before it spends more.'
  },
  {
    q: 'Can it break my repository?',
    a: 'It can run commands and edit files, so you choose what waits for your approval. Tasks can work on their own branch, every file edit is checkpointed, and you can rewind a task to before any instruction. Keep your work in version control either way.'
  },
  {
    q: 'What are instances?',
    a: 'Helper agents a task starts to split up big work. Each gets its own brief and, if it writes, normally its own branch. A task runs up to 16 at once, and instances cannot start instances of their own. See <a href="/features/instances">Instances</a>.'
  },
  {
    q: 'Does it collect telemetry?',
    a: 'There is no analytics or usage tracking. Crash and error reports are off by default. If you turn them on, error messages are removed and file paths are cut to file names before anything is sent.'
  },
  {
    q: 'How do updates work?',
    a: 'The app checks for a new version when it starts and every six hours, shows you the release notes, and downloads only when you click. You restart to install.'
  },
  {
    q: 'Who makes it?',
    a: 'Vyotiq. The source, releases and issue tracker are on <a href="https://github.com/vyotiqai">GitHub</a>.'
  }
]
